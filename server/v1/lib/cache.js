const Redis = require('ioredis');

const config = require('../../configs');

const redis = new Redis({
	keyPrefix: 'sv-api:v1:',
	port: config.v1.cache.port,
	host: config.v1.cache.host,
	password: config.v1.cache.auth,
	family: config.v1.cache.ipv,
	suffix: config.v1.cache.sfx
});

const redisHost = redis.connector.options.host + ':' + redis.connector.options.port;

redis
	.on('ready', function () {
		console.info('redis connected', redisHost);
	})
	.on('error', function (err) {
		console.error('redis error', err);
	});

module.exports = redis;
