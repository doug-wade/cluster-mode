var cluster = require('../');

var config = {
	max: 0
};

cluster.on('cluster.non.ready', function () {
	console.log('READY!!!!');
});

cluster.addShutdownTask(function (cb) {
	cb();
});

cluster.start(config);

setInterval(function () {

}, 10000);
