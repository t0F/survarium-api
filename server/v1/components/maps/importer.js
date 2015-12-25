'use strict';

const Promise = require('bluebird');
const apiNative = require('../../lib/api-native');
const cache = require('../../lib/cache');
const db = require('../../lib/db');
const config = require('../../../configs');
const Maps = db.model('Maps');

const languages = config.api.languages;

const CACHEKEY = 'maps:loaddict:';
const EXPIRE = 60 * 60 * 24 * 5;
const logKey = 'mapDict:';

function saveDict(lang, data) {
	return new Promise(function (resolve, reject) {
		if (!lang || !data) {
			return reject(logKey + ' empty save params');
		}
		var dict = data.dictionary;
		var promises = Object.keys(dict).map(function (key) {
			var item = dict[key];
			var id = Number(item.map_id);
			var data = { };
			data[lang] = {
				name: item.name,
				mode: item.mode,
				weather: item.weather
			};
			return Maps.findOne({ id: id }).exec()
				.then(function (map) {
					if (!map) {
						return Maps.create({
							id: id,
							lang: data
						});
					}
					return map.set(`lang.${lang}`, data[lang]).save();
				})
				.catch(console.error.bind(console, logKey));
		});
		var promise = Promise.all(promises);
		resolve(promise);
	});
}

function loadDict(lang) {
	const cachekey = CACHEKEY + lang;
	return cache
		.get(cachekey)
		.then(function (loading) {
			if (loading) {
				return;
			}
			return cache.set(cachekey, true, 'EX', EXPIRE)
				.then(function () {
					return apiNative.getMapsDict({ language: lang })
						.then(saveDict.bind(null, lang))
						.then(function () {
							console.info(logKey, 'loaded', lang);
						})
						.catch(function (err) {
							console.error(logKey, 'cannot load', lang, err);
							setTimeout(loadDict.bind(loadDict, lang), 1000 * 60 * 5);
							return cache.del(cachekey);
						});
				})
				.catch(console.error.bind(console, logKey, 'cannot set cache status'));
		})
		.catch(console.error.bind(console, logKey, 'cannot get cache status'));
}

const loadAllForms = function () {
	languages.forEach(loadDict);
};

setInterval(loadAllForms, EXPIRE * 1000);

/*cache.multi().del(CACHEKEY + languages[0]).del(CACHEKEY + languages[1]).exec().then(function () {
	console.info(logKey, 'cache cleaned');
});*/

setTimeout(loadAllForms, (Math.random() * 1000) >>> 0);
