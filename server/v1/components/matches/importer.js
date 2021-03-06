'use strict';

const debug = require('debug')('importer:matches');
const Promise = require('bluebird');
const apiNative = require('../../lib/api-native');
const cache = require('../../lib/cache');
const db = require('../../lib/db');
const utils = require('../../lib/utils');
const config = require('../../../configs');
const notifications = require('../../services/telegram/triggers');
const Matches = require('./model');
const MatchesUnloaded = db.model('MatchesUnloaded');
const Maps = require('../maps/model');
const Place = require('../place/model');
const Mode = require('../mode/model');
const Weather = require('../weather/model');
const Stats = require('../stats/model');
const Players = require('../players/model');
const ClansImporter = require('../clans/importer');

const CACHEKEY = 'matches:load';
const CACHEIMPORTKEY = CACHEKEY + cache.options.suffix + ':last';
const EXPIRE = 60 * 1;
const IMPORT_MATCH_TILL = +process.env.IMPORTER_MATCH_TILL;
const logKey = 'match:';

let gracefulShutdown;

function tryToShutdown() {
	if (gracefulShutdown) {
		console.log(`executing ${process.pid} shutdown...`);

		return process.nextTick(() => {
			process.exit(0);
		});
	}
}

function saveStats(matchData, match) {
	debug(`saving stats for match ${match.id}`);

	const isRating = Boolean(match.rating_match);
	let statsData = matchData.accounts;
	let createdStats = {};

	function saveStat(stat, player) {
		stat.player = player;
		createdStats[stat._id] = stat;

		return createdStats;
	}

	let promises = Object.keys(statsData).reduce(function (stats, teamNum) {
		let team = statsData[teamNum];

		if (!team) {
			return stats;
		}

		return stats.concat(Object.keys(team)
        .sort(function (a, b) {
            return team[b].score - team[a].score;
        })
        .map(function (key, place) {
			let playerStats = team[key];

			return function () {
				return Players
					.load({ id: playerStats.pid })
					.then(function (player) {
						debug(`player ${playerStats.pid} ${player.nickname} loaded`);
						debug(`creating stats document for player ${player.nickname} and match ${match.id}`);

						let kills = +playerStats.kill || 0;
						let dies = +playerStats.die || 0;
						let document = {
							date : match.date,
							match: match._id,
							map  : match.map,
							battlefield: match.place,
							mode  : match.mode,
							weather : match.weather,
							player: player._id,
							team  : teamNum,
							level : match.level,
                            rating_match: isRating,
							elo   : (player.progress || {})[`elo-${isRating ? 'rating' : 'random'}`] || 0,
							kills : kills,
							dies  : dies,
							kd : +utils.kd(kills, dies),
							victory: !!+playerStats.victory,
							score  : +playerStats.score || 0,
                            place: place + 1,
							headshots: +playerStats.headshot_kill || 0,
							grenadeKills: +playerStats.grenade_kill || 0,
							meleeKills  : +playerStats.melee_kill || 0,
							artefactKills: +playerStats.artefact_kill || 0,
							pointCaptures: +playerStats.capture_a_point || 0,
							boxesBringed : +playerStats.bring_a_box || 0,
							artefactUses : +playerStats.use_artefact || 0
						};

						if (player.clan) {
							document.clan = player.clan;
						}

						return Stats
							.create(document)
							.tap(function (stat) {
								return saveStat(stat, player);
							})
							.tap(function (stat) {
								debug(`stats document for player ${player.nickname} and match ${match.id} created`);
								return player.addStat(stat, matchData);
							});
					});
			};
		}));
	}, []);

	/**
	 * PARALLEL WAY
	 */
	if (process.env.IMPORTER_II_PLAYERS) {
		return Promise
			.all(promises
				.map(function (promise) {
					return promise();
				}))
			.catch(function (err) {
				console.error(`${logKey} error happen while creating stat`);
				console.error(err.stack);
			})
			.then(function () {
				return ClansImporter.clanwar({ match: match, stats: createdStats, matchData: matchData });
			})
			.then(function (clanwar) {
				if (clanwar) {
					notifications.importStatus({
						type: 'clanwar',
						match: match.id
					});
				}
				return match
					.update({
						stats: Object.keys(createdStats),
						clanwar: !!clanwar,
						clans: clanwar
					})
					.exec()
					.then(function () {
						debug(`stats refs for match ${match.id} saved`);
						return match;
					});
			});
	}

	/**
	 * STACK WAY
	 */
	return new Promise(function (resolve, reject) {
		(function next() {
			var fn = promises.shift();
			if (!fn) {
				debug(`saving stats refs for match ${match.id}`);
				return ClansImporter.clanwar({ match: match, stats: createdStats, matchData: matchData })
				.then(function (clanwar) {
					if (clanwar) {
						notifications.importStatus({
							type: 'clanwar',
							match: match.id
						});
					}
					return match
						.update({
							stats: Object.keys(createdStats),
							clanwar: !!clanwar,
							clans: clanwar
						})
						.exec()
						.then(function () {
							debug(`stats refs for match ${match.id} saved`);
							return resolve(match);
						});
				});
			}
			fn().tap(next).catch(reject);
		})();
	});
}

var lastImport;
var lastImportMatch;
var importInProgress;

/**
 * Remove bots from stats
 * @param match
 */
function filterMatch (match) {
    if (!match || !match.stats || !match.stats.accounts) {
        return;
    }

    var realPlayers = 0;
    var teams = match.stats.accounts;
    var playerIndex;
    var filteredAccounts = {};

    var checkPlayer = (team, result, index) => {
        var player = team[index];

        if (!player.pid) {
            return;
        }

        realPlayers++;
        result[playerIndex++] = player;
    };

    Object.keys(teams).forEach(teamId => {
        var team = teams[teamId];
        var filteredTeam = filteredAccounts[teamId] = {};

        playerIndex = 0;

        Object.keys(team).forEach(checkPlayer.bind(null, team, filteredTeam));
    });

    match.stats.accounts = filteredAccounts;

    return {
        match: match,
        realPlayers: realPlayers
    };
}

/**
 * Match document creator
 * And related models fill trigger
 * @param {Object} data     Match data from API
 * @returns {Object|Promise}
 */
function saveMatch(data) {
    let id = data.match_id;

    debug(`saving match ${id}`);

    let filteredData = filterMatch(data);

    if (!filteredData) {
        debug(`wrong match ${id} data structure`);

        return Promise.resolve(null);
    }

    if (filteredData.realPlayers < 2) {
        debug(`match ${id} have only ${filteredData.realPlayers} real player(s)`);

        return Promise.resolve(null);
    }

    data = filteredData.match;

	let statsData = data.stats;

    let deps = statsData.map_id !== undefined ? {
        map: Maps.findOne({ id: Number(statsData.map_id) }).lean()
    } : {
        place: Place.get({ title: statsData.map, language: config.api.langDefault }),
        mode: Mode.get({ title: statsData.mode, language: config.api.langDefault }),
        weather: Weather.get({ title: statsData.weather, language: config.api.langDefault })
    };

	return Promise.props(deps)
	.then(result => {
	    let { place, mode, weather, map } = result;

	    if (!place && !mode && !weather && !map) {
            debug(`cannot load map for match ${id}`);

            throw new Error(`no map ${statsData.map_id} found`);
        }

		debug(`creating document for match ${id}`);

	    let doc = {
            id: data.match_id,
            date: new Date(statsData.time_start.replace(/\s/, 'T')),
            duration: statsData.game_duration,
            server: statsData.server_id,
            replay: statsData.replay_path === '' ? undefined : statsData.replay_path,
            level: statsData.match_level,
            rating_match: statsData.rating_match,
            score: [0, 1].map(function (teamNum) {
                return statsData[`team_${teamNum + 1}_score`];
            }).filter(Boolean).map(Number),
        };

	    if (map) {
	        doc.map = map._id;
        } else {
            doc.place = place._id;
            doc.mode = mode._id;
            doc.weather = weather._id;
            doc.map_version = Number(statsData.map_version);

            if (isNaN(doc.map_version)) {
                doc.map_version = 0;
            }
        }

		return Matches
			.create(doc)
			.tap(function (match) {
				debug(`document for match ${id} created`);
				lastImport = match.date / 1000 >>> 0;
				return saveStats(statsData, match);
			});
	});
}

/**
 * Store failed match import
 * @param {Number} id   Match ID
 * @param {Number} ts   Match timestamp
 * @returns {Object|Promise}
 */
function saveUnloaded(id, ts) {
	debug(`adding unloaded match ${id}`);
	return MatchesUnloaded
		.findOrCreate({
			id: id,
			date: (ts || 0) * 1000
		})
		.then(function () {
			debug(`unloaded match ${id} added`);
			return { id: id, status: 'no-data' };
		})
		.catch(console.error.bind(console, logKey, 'cannot add unloaded match'));
}

/**
 * Match status checker and API data fetcher
 * @param {Number} id   Match ID
 * @param {Number} ts   Match timestamp
 * @returns {Object|Promise}
 */
function importMatch(id, ts) {
	debug(`importing match ${id}`);

	return Matches
		.findOne({ id: id })
		.then(match => {
			if (match) {
				debug(`match ${id} exists`);

				return { id, status: 'exists', match };
			}

			debug(`loading match ${id} from API`);

			return apiNative.getMatchStatistic({ id: id })
				.then(match => {
					if (!match) {
						debug(`match ${id} cannot be loaded from API`);

						return saveUnloaded(id, ts);
					}
					return saveMatch(match)
						.then(doc => {
						    // WARNING! DOC may be NULL after filtration
							debug(`match ${id} imported`);

							return { id, status: 'added', match: doc };
						});
				});
		})
		.catch(function (err) {
			console.error(logKey, 'cannot import match', id, err.stack);

			if (err.statusCode === 422) {
				debug(`match ${id} cannot be loaded from API`);

				return saveUnloaded(id, ts)
					.then(() => {
						return { id, status: 'no source', error: err };
					});
			}

			return { id, status: 'error', error: err };
		});
}

function loadByID(last) {
	let matchId = +last.id;

	console.log(`load at ${new Date()} from match=${matchId}`);

	let matchesToImport = +process.env.IMPORTER || 50;
	let matches = [];

	debug(`need to import ${matchesToImport} new matches`);

	return apiNative.getMaxMatchId({})
		.then(function (max) {
			let latestAvailable = +max.max_match_id.api - matchesToImport;
			let latestPossible = matchId + matchesToImport;

            if (IMPORT_MATCH_TILL) {
                latestAvailable = Math.min(IMPORT_MATCH_TILL, latestAvailable);
            }

			let length = latestPossible > latestAvailable ?
				latestAvailable - matchId
				: matchesToImport;

			for (let i = 1; i <= length; i++) {
				matches.push(matchId + i);
			}

			return new Promise(function (resolve, reject) {
				let errors = [];
				let exit = function () {
					debug(`imported ${length} new matches`);
					if (!length || length < 0) {
						/**
						 * HEAD state, no fresh matches available yet
						 */
						tryToShutdown();
						return resolve();
					}
					/**
					 * Rollback last import date if amount of errors
					 * More than 10%
					 */
					if (length - errors.length < length * .1) {
						debug(`too many (${errors.length}) matches import errors in matches.`);
						let id = matches[0] || matchId;
						lastImportMatch = id;
						debug(`setting lastImport id=${lastImportMatch}`);
						cache.hmset(CACHEIMPORTKEY, 'id', id, 'ts', lastImport,'host', config.v1.telegram.hostname)
							.then(function () {
								let lastError = errors[errors.length - 1] || {};
								notifications.importStatus({
									type: 'tooMuchErrors',
									errors: errors.length,
									total: length,
									id: id,
									ts: lastImport,
									lastError: lastError.error && lastError.error.stack || lastError.error,
									lastErrorMatch: lastError.id
								});
								tryToShutdown();
								return resolve();
							});
					}

					let id = matches[length - 1] || matchId;
					lastImportMatch = id;
					debug(`setting lastImport id=${id}`);
					return cache
						.hmset(CACHEIMPORTKEY, 'id', id, 'ts', lastImport, 'host', config.v1.telegram.hostname)
						.then(function () {
							tryToShutdown();
							/**
							 * If match list is full, load its remaining
							 */
							if (matchesToImport === length) {
								debug(`need to import next portion of new matches`);
								return loadByID({ id: id })
									.then(resolve)
									.catch(reject);
							}
							return resolve();
						})
						.catch(resolve);
				};

				if (process.env.IMPORTER_II_MATCHES) {
					/**
					 * PARALLEL WAY
					 */
					return Promise.all(matches.map(function (id) {
						var ts = process.hrtime();
						return importMatch(id)
							.tap(function (result) {
								ts = process.hrtime(ts);
								debug(`imported match ${id} with result ${result.status} in ${(ts[0] + ts[1] / 1e9).toFixed(2)}sec.`);
								console.log(`${logKey} ${id} ${result.status}`);
								if (result.status === 'error') {
									errors.push({ id: id, error: result.error })
								}
							})
							.catch(reject);
					})).then(exit).catch(reject);
				}

				/**
				 * STACK WAY
				 *
				 * Match import runner
				 * Each API operation must be delayed to fit max 5 req/sec.
				 *
				 * TODO: change lastImport to real match date
				 */
				var i = 0;
				var next = function () {
					var id = matches[i++];
					if (!id) {
						return exit();
					}
					var ts = process.hrtime();
					return importMatch(id)
						.tap(function (result) {
							ts = process.hrtime(ts);
							debug(`imported match ${id} with result ${result.status} in ${(ts[0] + ts[1] / 1e9).toFixed(2)}sec.`);
							console.log(logKey, id, result.status);
							if (result.status === 'error') {
								errors.push({ id: id, error: result.error })
							}
						})
						.then(next)
						.catch(reject);
				};
				return next();
			});
		});
}

var importHoles = [];

/**
 * Load a pack of matches available from date
 * @param {Object} last
 * @param {Number} last.ts
 * @returns {Promise}
 */
function loadByTS(last) {
	var date = last.ts;
	var matchesToImport = +process.env.IMPORTER || 50;
	var offset = last.offset || 0;
	debug(`loading ${matchesToImport} matches at ${new Date()} from ts=${date} with offset ${offset} (${new Date(date * 1000)})`);
	/**
	 * Fetches list of matches available from date
	 */
	return apiNative.getNewMatches({ timestamp: date, limit: matchesToImport, offset: offset })
		.then(function (matches) {
			if (!matches.matches) {
				notifications.importStatus({
					type: 'noUpdates',
					ts: lastImport
				});
				let error = new Error(`no new matches available from ${date} (${new Date(date * 1000)})`);
				error.handled = true;
				throw error;
			}
			matches = matches.matches;
			var ids = Object.keys(matches);

			//FIXME: https://github.com/PhpSurvarium/SurvariumAPI/issues/35
			ids = ids.sort(function (a, b) {
				return Number(matches[a]) - Number(matches[b]);
			});
			//TODO: implement holes detection
			/*
			var holes = [
				{
					id: Number,
					tries: Number
				}
			];

			if (holes.length > critical && noNewMatches) {
				tryToFixHoles(holes);
			}
			*/

			var length = ids.length;
			debug(`need to import ${length} new matches`);
			if (!length) {
				return null;
			}
			return new Promise(function (resolve, reject) {
				var errors = [];
				var i = 0;
				var exit = function () {
					debug(`imported ${length} new matches`);
					/**
					 * Rollback last import date if amount of errors
					 * More than 10%
					 */
					if (length - errors.length < length * .1) {
						debug(`too many (${errors.length}) matches import errors in matches.`);
						let id = ids[0];
						lastImport = matches[id];
						debug(`setting lastImport on ts=${lastImport} from id=${id}`);
						cache.hmset(CACHEIMPORTKEY, 'ts', lastImport, 'id', id, 'host', config.v1.telegram.hostname);
						let lastError = errors[errors.length - 1];
						notifications.importStatus({
							type: 'tooMuchErrors',
							errors: errors.length,
							total: length,
							ts: lastImport,
							lastError: lastError.error,
							lastErrorMatch: lastError.id
						});
						tryToShutdown();
						return resolve();
					}

					let id = ids[length - 1];
					lastImport = matches[id];
					debug(`setting lastImport on ts=${lastImport} from id=${id}`);
					return cache
						.hmset(CACHEIMPORTKEY, 'ts', lastImport, 'id', id, 'host', config.v1.telegram.hostname)
						.then(function () {
							tryToShutdown();
							/**
							 * If match list is full, load its remaining
							 */
							if (matchesToImport === length) {
								debug(`need to import next portion of new matches`);
								/**
								 * A lot of matches was imported at the single moment
								 */
								if (length > 1 && lastImport === matches[ids[length - 2]]) {
									debug(`increasing offset for lastImport`);
									/**
									 * Setting last import ts to start
									 * And align it with offset
									 */
									lastImport = last.ts;
									offset += matchesToImport;
								} else {
									offset = 0;
								}
								return loadByTS({ ts: lastImport, match: id, offset: offset })
									.then(resolve)
									.catch(reject);
							}

							if (lastImport - 1 !== last.ts) {
								/**
								 * getNewMatches responds by matches
								 * which import time if $GT than timestamp,
								 * not $GTE, so moving timestamp little backwards
								 */
								lastImport = lastImport - 1;
							}

							return resolve();
						})
						.catch(resolve);
				};

				if (process.env.IMPORTER_II_MATCHES) {
					/**
					 * PARALLEL WAY
					 */
					return Promise.all(ids.map(function (id) {
						var ts = process.hrtime();
						return importMatch(id, matches[id])
							.tap(function (result) {
								ts = process.hrtime(ts);
								debug(`imported match ${id} with result ${result.status} in ${(ts[0] + ts[1] / 1e9).toFixed(2)}sec.`);
								console.log(logKey, id, result.status, new Date(matches[id] * 1000));
								lastImport = matches[id];
								if (result.status === 'error') {
									errors.push({ id: id, error: result.error })
								}
							})
							.catch(reject);
					})).then(exit).catch(reject);
				}

				/**
				 * STACK WAY
				 *
				 * Match import runner
				 * Each API operation must be delayed to fit max 5 req/sec.
				 *
				 * TODO: change lastImport to real match date
				 */
				var next = function () {
					var id = ids[i++];
					if (!id) {
						return exit();
					}
					var ts = process.hrtime();
					return importMatch(id, matches[id])
						.tap(function (result) {
							ts = process.hrtime(ts);
							debug(`imported match ${id} with result ${result.status} in ${(ts[0] + ts[1] / 1e9).toFixed(2)}sec.`);
							console.log(logKey, id, result.status, new Date(matches[id] * 1000));
							lastImport = matches[id];
							if (result.status === 'error') {
								errors.push({ id: id, error: result.error })
							}
						})
						.then(next)
						.catch(reject);
				};
				return next();
			});
		});
}

var startOfTimes = {
	date: new Date(process.env.IMPORTER_START || '2016-05-15T21:08:03Z'),
	match: +process.env.IMPORTER_MATCH || 4895046
};

/**
 * Resolve timestamp of latest available match
 * @returns {Number}
 */
function getLastImport() {
	return (lastImport || lastImportMatch)?
		Promise.resolve({
			ts: lastImport,
			id: lastImportMatch
		}) :
		cache
			.hgetall(CACHEIMPORTKEY)
			.then(function (result) {
				if (result.ts && result.id) {
					lastImport = result.ts;
					lastImportMatch = result.id;
					return result;
				}
				return { ts: startOfTimes.date.getTime() / 1000 >>> 0, id: startOfTimes.match };
			});
}

/**
 * Import planner
 */
function loader() {
	debug(`[${process.pid}] (${new Date()}) trying to import new matches slice`);

	const cachekey = CACHEKEY + cache.options.suffix;

	return cache
		.get(cachekey)
		.then(loading => {
			if (loading) {
				debug(`[${process.pid}] cannot start new import: another import is running on process [${loading}]`);

				return;
			}

			importInProgress = true;

			return cache.set(cachekey, process.pid, 'EX', EXPIRE)
				.then(() => {
					return getLastImport()
						.tap(function (last) {
							console.log(`loader date ts=${last.ts} match=${last.id}`);
						})
						.then(~['true'].indexOf(process.env.IMPORTER_BY_ID) ? loadByID : loadByTS)
						.tap(cache.del.bind(cache, cachekey))
						.tap(function () {
							console.info(logKey, 'loaded');
						})
						.catch(function (err) {
							!err || !err.handled && notifications.importStatus({
								type: 'fatal',
								ts: lastImport,
								match: lastImportMatch,
								error: err
							});
							console.error(logKey, 'cannot make import', err);
						});
				})
				.catch(console.error.bind(console, logKey, 'cannot set cache status'));
		})
		.catch(console.error.bind(console, logKey, 'cannot get cache status'))
		.tap(function () {
			debug(`[${process.pid}] planning next import`);
			importInProgress = false;
			tryToShutdown();
			setTimeout(function () {
				debug(`[${process.pid}] starting planned import`);
				return loader();
			}, 1000 * (EXPIRE + 5));
		});
}

if (config.v1.importer) {
	process.on('SIGTERM', function () {
		console.log(`register importer ${process.pid} shutdown...`);
		gracefulShutdown = true;

		if (!importInProgress) {
			tryToShutdown();
		}
	});

	require('fs').writeFile(require('path').join(__dirname, '../../../../', 'importer.pid'), `${process.pid}\n`, function (err) {
		if (err) {
			throw err;
		}
		console.log(`importer PID: ${process.pid}`);
	});

	setTimeout(loader, (Math.random() * 30000) >>> 0);
}

/**
 * Remove loader stoppers
 * @returns {Promise}
 */
function deblock() {
	return cache.multi().del(CACHEKEY).exec().then(function () {
		console.info(logKey, 'cache cleaned');
	});
}

if (process.env.DEBLOCK) {
	deblock();
}

module.exports = {
	deblock: deblock,
	loader: loader,
	importMatch: importMatch
};
