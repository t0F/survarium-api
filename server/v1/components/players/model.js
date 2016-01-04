const Promise = require('bluebird');
const mongoose = require('mongoose');
const timestamps = require('mongoose-timestamp');
const db = require('../../lib/db');
const importer = require('./importer');
const Clans = db.model('Clans');

const Schema = mongoose.Schema;

const scoreMicro = {
	type: Number,
	default: 0,
	index: true
};

const PlayersSchema = new Schema({
	id: {
		type    : String,
		index   : { unique: true },
		required: true,
		trim: true
	},
	nickname: {
		type: 'String',
		index: { unique: true },
		required: true,
		trim: true
	},
	clan: {
		type: Schema.Types.ObjectId,
		ref : 'Clans'
	},
	clan_meta: {
		id: {
			type: Number,
			index: true
		},
		abbr: {
			type: String,
			index: true
		}
	},
	progress: {
		elo: {
			type: Number,
			index: true
		},
		level: Number,
		experience: {
			type: Number,
			index: true
		}
	},
	total: {
		matches: scoreMicro,
		victories: scoreMicro,
		kills: scoreMicro,
		dies: scoreMicro,

		headshots: scoreMicro,
		grenadeKills: scoreMicro,
		meleeKills: scoreMicro,
		artefactKills: scoreMicro,
		pointCaptures: scoreMicro,
		boxesBringed: scoreMicro,
		artefactUses: scoreMicro
	},
	stats: [
		{
			type: Schema.Types.ObjectId,
			ref : 'Stats'
		}
	],
	ammunition: [{
		slot: {
			type: Schema.Types.ObjectId,
			ref : 'Slots'
		},
		item: {
			type: Schema.Types.ObjectId,
			ref : 'Items'
		},
		amount: Number
	}],
	deletedAt: Date
});

PlayersSchema.plugin(timestamps);

PlayersSchema.statics.load = function () {
	return importer.load.apply(this, arguments);
};

PlayersSchema.methods.addStat = function (stat) {
	var self = this;
	var updaters = [this.update({
		$push: {
			stats: stat._id
		},
		$inc: {
			'total.headshots': stat.headshots || 0,
			'total.grenadeKills': stat.grenadeKills || 0,
			'total.meleeKills': stat.meleeKills || 0,
			'total.artefactKills': stat.artefactKills || 0,
			'total.pointCaptures': stat.pointCaptures || 0,
			'total.boxesBringed': stat.boxesBringed || 0,
			'total.artefactUses': stat.artefactUses || 0
		}
	}).exec()];
	if (stat.clan) {
		updaters.push(Clans.update({ _id: stat.clan }, {
			$push: {
				stats: stat._id
			},
			$inc: {
				'total.matches': 1,
				'total.victories': stat.victory ? 1 : 0,
				'total.kills': stat.kills || 0,
				'total.dies': stat.dies || 0,

				'total.headshots': stat.headshots || 0,
				'total.grenadeKills': stat.grenadeKills || 0,
				'total.meleeKills': stat.meleeKills || 0,
				'total.artefactKills': stat.artefactKills || 0,
				'total.pointCaptures': stat.pointCaptures || 0,
				'total.boxesBringed': stat.boxesBringed || 0,
				'total.artefactUses': stat.artefactUses || 0
			}
		}));
	}
	return Promise
		.all(updaters)
		.then(function () {
			return self;
		});
};

module.exports = db.model('Players', PlayersSchema);