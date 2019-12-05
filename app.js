var conf = require("./config");
var request = require("request");
var log4js = require('log4js');
var schedule = require('node-schedule');
var AWS = require('aws-sdk');
AWS.config.update({
    accessKeyId: conf.accessKeyId,
    secretAccessKey: conf.secretAccessKey
});
var logger = log4js.getLogger();
logger.level = 'debug';
var listToUpdate = [];
const express = require('express');
const server = new express();
//==========Configuration===============
var cf_email = conf.cf_email;
var cf_key = conf.cf_key;
var locations = conf.locations;
var regionMap = {
    "jp": "ap-northeast-1",
    "sg": "ap-southeast-1"
}
var serverMap = {
    "jp": "Ubuntu-1GB-Tokyo-1",
    "sg": "CentOS-1GB-Singapore-1"
}
var scheduleJobConfig = conf.scheduleJobConfig;

//=================Prometheus=====================
const client = require('prom-client');
const registry = client.register;
// const registry = new Registry();
// client.collectDefaultMetrics({ registry });
// Probe every 5th second.
// client.collectDefaultMetrics({ timeout: 5000 });

const counter = new client.Counter({
    name: 'nasi_evenement_count',
    help: '监控程序运行状况',
    labelNames: ['location', 'evenement', 'status'],
    registers: [registry]
});
//======================================

/**
 * 根据 需要更新的域名列表找出要更新的域名
 * @param {*} array 域名列表
 */
function findDNSList(array) {
    var list = [];
    logger.info("在 %s 条nasi-campur配置记录中查找", array.length);
    for (var i = 0; i < locations.length; i++) {
        var loc = locations[i];
        for (var j = 0; j < array.length; j++) {
            if (array[j].name.indexOf("-" + loc + "-") != -1) {
                array[j].tag = loc;
                list.push(array[j]);
            }
        }
    }
    return list;
}

function getListDomaines2Update() {
    return new Promise(function (resolve, reject) {
        request({
            method: 'GET',
            url: "https://api.cloudflare.com/client/v4/zones/96e4978ce217656f4f344935cbce6da6/dns_records?per_page=30",
            headers: {
                "Content-Type": "application/json",
                "X-Auth-Email": cf_email,
                "X-Auth-Key": cf_key,
            }
        },
            function (error, response, body) {
                if (!error) {
                    var results = JSON.parse(body).result;
                    var listDns = results.filter(e => {
                        return e.name.indexOf("nasi-campur") != -1
                    });
                    resolve(findDNSList(listDns));
                } else {
                    logger.error("Can't get domaines list.");
                    resolve("Can't get domaines list.");
                }
            });

    });
}

/**
 * 更新DNS信息
 * @param {*} ip 
 */
function updateDNS(dnsRecord, ip) {
    return new Promise(function (resolve, reject) {
        var jsonData = {
            "type": "A",
            "name": dnsRecord.name,
            "content": ip,
            "ttl": 1,
            "proxied": false
        }
        request({
            method: 'PUT',
            url: "https://api.cloudflare.com/client/v4/zones/" + dnsRecord.zone_id + "/dns_records/" + dnsRecord.id,
            headers: {
                "X-Auth-Email": cf_email,
                "X-Auth-Key": cf_key,
                "Content-Type": "application/json"
            },
            json: jsonData
        },
            function (error, response, body) {
                if (!error) {
                    logger.info("[Cloudflare] DNS => " + (body.success ? "success" : "false"));
                    counter.inc({ location: dnsRecord.name, evenement: 'updateDNS',status:'OK' });
                    resolve("[Cloudflare] " + dnsRecord.name + " => " + ip);
                } else {
                    console.log(error);
                    counter.inc({ location: dnsRecord.name, evenement: 'updateDNS',status:'KO' });
                    resolve("KO");
                }
            });
    });
}

function checkStatus(dns) {
    var url = "http://" + dns.name + ":8762/actuator/info"
    return new Promise(function (resolve, reject) {
        request.get({ url, timeout: 10000 }, function (err, response, body) {
            if (!err) {
                logger.info("[OK] => %s 正常", dns.name);
                counter.inc({ location: dns.name, evenement: 'checkStatus',status:'OK' });
                resolve(null);
            } else {
                if (err.code == "ETIMEDOUT") {
                    logger.warn("[KO] => %s 服务器ip可能被墙,准备更换ip.", dns.name);
                    counter.inc({ location: dns.name, evenement: 'checkStatus',status:'KO' });
                } else if (err.code == "ECONNREFUSED") {
                    logger.error("[KO] => %s 服务器可能没有启动.", dns.name);
                }
                resolve(dns.name)
            }
        });
    });
}

function getLightSailInstance(region) {
    AWS.config.update({
        region: region
    });
    return new AWS.Lightsail();
}
/**
 * 删除对应区域的ip
 * @param {*} lightsail lightsail
 * @param {*} region 区域
 */
function deleteOldStaticIp(lightsail, region) {
    return new Promise(function (resolve, reject) {
        var staticIpName = "static-" + region;
        lightsail.releaseStaticIp({
            staticIpName: staticIpName
        }, function (err, data) {
            if (!err) {
                console.log("[LightSail][OK] 删除StaticIp => %s", staticIpName);
                resolve("[LightSail][OK] 删除StaticIp => %s", staticIpName)
            } else {
                console.log("[LightSail][KO] => 删除StaticIp %s", err);
                logger.error(err.message);
            }
        });
    });
}

function getNewStaticIp(lightsail, region, instanceName) {
    return new Promise(function (resolve, reject) {
        var staticIpName = "static-" + region;
        // add
        lightsail.allocateStaticIp({
            staticIpName: staticIpName
        }, async function (err, data) {
            if (err) {
                // 已经存在了 需要删除
                if (err.message.indexOf('already in use') != -1) {
                    await deleteOldStaticIp(lightsail, region);
                    logger.info("[LightSail] 删除已存在的ip地址 => OK");
                    lightsail.allocateStaticIp({
                        staticIpName: staticIpName
                    }, async function (err, data) {
                        if (!err) {
                            resolve(await addNewStaticIp(lightsail, region, instanceName));
                        } else {
                            logger.error(err.message);
                        }
                    });
                }
            } else {
                resolve(await addNewStaticIp(lightsail, region, instanceName));
            }
        });
    });
}

function updateNasiCampurIp(ip) {
    var url = "http://" + ip + ":8762/updateIp?ip=" + ip;
    logger.info("更新重载 nasi-campur, 新ip地址 => " + ip);
    return new Promise(function (resolve, reject) {
        request.get({ url, timeout: 10000 }, function (err, response, body) {
            if (!err) {
                resolve("重载 nasi-campurp 配置完毕 ");
            } else {
                console.log(err)
            }
        });
    });
}

function addNewStaticIp(lightsail, region, instanceName) {
    var staticIpName = "static-" + region;
    return new Promise(function (resolve, reject) {
        lightsail.attachStaticIp({
            instanceName: instanceName,
            staticIpName: staticIpName
        }, function (err, data) {
            if (!err) {
                logger.info("[LightSail] 添加新动态ip成功");
                lightsail.getStaticIp({
                    staticIpName: "static-" + region
                }, function (err, data) {
                    if (!err) {
                        logger.info("[LightSail] 获取ip成功 => %s", data.staticIp.ipAddress);
                        resolve(data.staticIp.ipAddress);
                    } else {
                        resolve(err.message);
                    }
                });
            } else {
                logger.error(err.message);
            }
        });
    });
}

async function main() {
    // cache
    if (listToUpdate.length == 0) {
        listToUpdate = await getListDomaines2Update();
        logger.info("找到 %s 条记录要更新", listToUpdate.length);
    }

    listToUpdate.forEach(async dns => {
        var reponse = await checkStatus(dns);
        if (reponse) {
            console.log(reponse + " => 需要更改ip地址");
            var lightsail = getLightSailInstance(regionMap[dns.tag]);
            var newIp = await getNewStaticIp(lightsail, regionMap[dns.tag], serverMap[dns.tag]);
            await updateNasiCampurIp(newIp);
            var res = await updateDNS(dns, newIp);
            if (res == "OK") {
                console.log("DNS 更新失败重新再更新一次 ");
                res = await updateDNS(dns, newIp);
                logger.info(res);
            } else {
                logger.info(res);
            }
        }
    });
    console.log("==========================");
}

const scheduleJobRun = () => {
    console.log("Monitor started!");
    schedule.scheduleJob(scheduleJobConfig, () => {
        main();
        console.log('自动定时任务:' + new Date());
        counter.inc({ location: 'CN', evenement: 'scheduleJobRun',status:'OK' });
    });
}

scheduleJobRun();
//main();
// server.get('/metrics', (req, res) => {
//     res.set('Content-Type', registry.contentType);
//     res.end(registry.metrics());
// });

server.get('/monitor', (req, res) => {
	res.set('Content-Type', registry.contentType);
	res.end(registry.getSingleMetricAsString('nasi_evenement_count'));
});


console.log('Server listening to 3000, metrics exposed on /metrics endpoint');
server.listen(3000);