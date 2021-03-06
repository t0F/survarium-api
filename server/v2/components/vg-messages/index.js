'use strict';

const config = require('../../../configs');
const router = require('express').Router();
const ctl    = require('./ctl');

router.get('/langs', (req, res) => {
    res.json(['ru', 'en']);
});

router.get('/devs', function (req, res) {
	res.json(ctl.devs());
});

router.get('/messages', function (req, res, next) {
	var query = req.query;

	ctl
		.list(query)
		.then(function (result) {
			return res.json(result);
		})
		.catch(next);
});

router.get('/messages/:messageId', function (req, res, next) {
	ctl
		.one(req.params.messageId)
		.then(function (result) {
			return res.json(result);
		})
		.catch(next);
});

if (config.importer.messages) {
	require('./importer');
}

module.exports = router;

