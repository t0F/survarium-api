'use strict';

var router = require('express').Router();

router.use('/clans',     require('./components/clans'));
/*router.use('/matches',   require('./components/matches'));
router.use('/players',   require('./components/players'));*/

module.exports = router;
