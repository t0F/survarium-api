'use strict';

var Discord = require('./index');
var debug = Discord.debug;
var Bans = require('./bans');

var config = require('../../../configs');
var PMCHANNELS = config.discord.pmChannels;

function setStatus(bot) {
	return bot
		.setPlayingGame('Survarium')
		.catch(err => debug('bot:status:err', err));
}

var pmChannels = [];
function getPM(bot) {
	let pms = PMCHANNELS;
	let botPMs = bot.privateChannels;
	pmChannels = Object
		.keys(botPMs)
		.map(Number)
		.reduce((result, pos) => {
			if (isNaN(pos) || pms.indexOf(botPMs[pos].recipient.username) === -1) {
				return result;
			}

			result.push(botPMs[pos]);
			return result;
		}, []);
}

var bot = Discord.bot({
	onReady: function (bot) {
		setStatus(bot);
		getPM(bot);
	}
});

bot
	.on('message', message => {
		let author = message.author;
		let source;

		const isAdminMessage = PMCHANNELS.indexOf(author.username) > -1;

		if (isAdminMessage) {
			Bans.router(message);
			return;
		}

		if (bot.user.id === author.id) {
			return;
		} else if (message.channel instanceof Discord.Module.PMChannel) {
			source = 'PM';
		} else if (message.mentions && message.mentions.length && message.mentions.filter(elem => elem.id === bot.user.id).length) {
			source = message.channel.name || message.channel.type;
		} else {
			return;
		}

		let txt = `<@${author.id}> [${source}]\n${message.content}`;

		Discord.sendMessage(pmChannels, txt);
	});

['debug', 'warn', 'messageDeleted', 'messageUpdated', 'disconnected','raw', 'serverCreated', 'serverDeleted', 'serverUpdated', 'channelCreated', 'channelDeleted', 'channelUpdated', 'serverRoleCreated', 'serverRoleDeleted', 'serverRoleUpdated', 'serverNewMember', 'serverMemberRemoved', 'serverMemberUpdated', 'presence', 'userTypingStarted', 'userTypingStopped', 'userBanned', 'userUnbanned', 'voiceJoin', 'voiceLeave', 'voiceStateUpdate']
	.forEach(event => bot
		.on(event, () => {
			debug(`bot:event:${event}`);
		}));