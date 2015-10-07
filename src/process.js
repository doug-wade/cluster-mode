'use strict';

var os = require('os');
var async = require('async');
var EventEmitter = require('events').EventEmitter;
var emitter = new EventEmitter();
var cluster = require('cluster');
var logger = require('../lib/logger');
var msg = require('../lib/msg');
var sigCode = require('../lib/sigcode');

// default number of max workers to start
var MAX = os.cpus().length;
// singlals
var SIGNALS = {
	SIGHUP: 'SIGHUP',
	SIGINT: 'SIGINT',
	SIGQUIT: 'SIGQUIT',
	SIGTERM: 'SIGTERM'
};
// master name
var MASTER = 'master';
// reload command
var PREFIX = 'cLuSToR-mOdE';
var CMD = {
	RELOAD: PREFIX + '__reload__',
	EXIT: PREFIX + '__exit__',
	SYNC: PREFIX + '__sync__',
	MSG: PREFIX + '__msg__'
};
// minimum lifespan for workers
// workers must be alive for at least 10 second
// otherwise it will NOT be auto re-spawn
var MIN_LIFE = 10000;
// number of works to start
var numOfWorkers = 0;
// auto respawn workers when they die
var autoSpawn = false;
// sync worker on/off
var syncWorker = true;
// flags
var isReloading = false;
var isShutdown = false;
var isMaster = false;
var shutdownLock = false;
// counter
var reloaded = 0;
// shutdown tasks to be executed before shutting down
var shutdownTasks = [];
// worker map used for master process only, but synced from master to workers
var workerMap = {};
// function to be executed right BEFORE exit of the process
var onExit = null;

var ee = new EventEmitter();

ee.addShutdownTask = function (task, runOnMaster) {

	if (typeof task !== 'function') {
		return false;
	}

	// default value of runOnMaster is true
	if (runOnMaster === undefined) {
		runOnMaster = true;
	}

	shutdownTasks.push({ task: task, runOnMaster: runOnMaster });

	return true;
};

ee.onExit = function (task) {

	if (typeof task !== 'function') {
		return false;
	}

	onExit = task;
};

ee.start = function (config) {

	if (cluster.isMaster) {
		// either non-cluster or master
		isMaster = true;
		logger.setName('MASTER: ' + process.pid);
	} else {
		logger.setName('WORKER: ' + process.pid);
	}

	// check config
	if (!config) {
		config = {};
	}
	// set logger if provided
	logger.set(config.logger);
	// decide how many workers to start
	// if this is 0, we run in non-cluster mode
	numOfWorkers = (config.max === 0) ? 0 : config.max || MAX;
	// auto re-spawn dead workers or not
	autoSpawn = config.autoSpawn || false;
	// sync worker: default is true
	syncWorker = config.sync === undefined || config.sync === true ? true : false;

	// if we are running in non-cluster mode, turn off syncWorker
	if (!ee.isCluster()) {
		syncWorker = false;
	}

	if (isMaster) {
		logger.info('Number of workers: ' + numOfWorkers);
		logger.info('Auto re-spawn: ' + autoSpawn);
		logger.info('Synchronaize worker map: ' + syncWorker);
	}

	// start cluster process
	start();
};

ee.getWorkers = function () {

	if (!syncWorker) {
		return {};
	}

	var map = {};
	for (var id in workerMap) {
		map[id] = {
			pid: workerMap[id].pid,
			started: workerMap[id].started
		};
	}
	return map;
};

ee.getWorkerIdByPid = function (pid) {
	
	if (!syncWorker) {
		return null;
	}

	for (var id in workerMap) {
		if (pid === workerMap[id].pid) {
			return id;
		}
	}

	return null;
};

ee.getWorkerPidById = function (id) {
	
	if (!syncWorker) {
		return null;
	}

	if (workerMap[id]) {
		return workerMap[id].pid;
	}

	return null;
};

ee.stop = function (error) {
	exit(error, error ? sigCode.CODES.FATAL_ERROR : sigCode.CODES.EXPECTED);
};

ee.isMaster = function () {
	if (isMaster && numOfWorkers) {
		return true;
	}
	return false;
};

ee.isCluster = function () {
	if (numOfWorkers) {
		return true;
	}
	return false;
};

ee.send = function (workerId, msgData) {
	var data = msg.createMsgData(CMD.MSG, workerId, msgData);

	if (isMaster) {
		var targetWorker = cluster.workers[workerId];		

		if (workerId && !targetWorker) {
			logger.error(
				'Message target worker [ID: ' + workerId +
				'] no longer exists'
			);
			return false;
		}

		data.from = MASTER;

		msg.send(data, cluster.workers[workerId]);
		return true;
	}

	data.from = cluster.worker.id;

	msg.send(data, null);
	return true;
};

module.exports = ee;

function start() {
	startListeners();
	var inClusterMode = startClusterMode();
	if (isMaster) {
		logger.info('Starting in cluster mode: ' + inClusterMode);
	}
}

function startClusterMode() {
	if (numOfWorkers > 1) {
		// cluster mode
		switch (cluster.isMaster) {
			case true:
				startMaster();
				ee.emit('cluster', 'master.ready', process.pid);
				ee.emit('cluster.master.ready', process.pid);
				break;
			case false:
				startWorker();
				ee.emit('cluster', 'worker.ready', process.pid);
				ee.emit('cluster.worker.ready', process.pid);
				break;
		}
		return true;
	}
	// non cluster mode
	ee.emit('cluster', 'non.ready');
	ee.emit('cluster.non.ready');
	return false;
}

function startListeners() {

	logger.info('Start listeners [pid:', process.pid + ']');

	process.on(SIGNALS.SIGHUP, reload);
	process.on(SIGNALS.SIGINT, function () {
		exit(null, SIGNALS.SIGINT);
	});
	process.on(SIGNALS.SIGQUIT, function () {
		exit(null, SIGNALS.SIGQUIT);
	});
	process.on(SIGNALS.SIGTERM, function () {
		exit(null, SIGNALS.SIGTERM);
	});
	process.on('exit', function (code) {
		if (code) {
			// some kind of error
			var errorName = sigCode.getNameByExitCode(code);
			logger.error('Error termination: (code: ' + code + ') ' + errorName);
		}
	});
}

function startMaster() {

	logger.info('Starting master process');

	// set up process termination listener on workers
	cluster.on('exit', handleWorkerExit);
	// 
	// spawn workers
	for (var i = 0; i < numOfWorkers; i++) {
		createWorker();
	}
}

function createWorker() {
	var worker = cluster.fork();
	// add it to the map
	workerMap[worker.id] = {
		started: Date.now(),
		pid: worker.process.pid
	};
	// worker to master message listener
	// this is a listener created in master process to listen
	// to the messages sent from a worker to master
	worker.on('message', function (data) {
		try {
			data = JSON.parse(data);
		} catch (e) {
			logger.warn('Message data not JSON:', data);
		}
		switch (data.command) {
			case CMD.MSG:
				msg.relay(CMD.MSG, data, worker);
				break;
			case CMD.EXIT:
				logger.info(
					'Exit instruction from worker:',
					worker.process.pid,
					data.error || null
				);
				exit(data.error, data.sig || SIGNALS.SIGTERM);
				break;
			default:
				break;
		}
	});

	logger.info('Worker (ID: ' + worker.id + ') [pid: ' + worker.process.pid + '] created');

	// sync worker map with all workers
	syncWorkerMap();

	return worker;
}

function syncWorkerMap() {
	if (syncWorker) {
		logger.verbose('Dispatch synchronize worker command');
		msg.send({ command: CMD.SYNC, map: workerMap });
	}
}

function handleWorkerExit(worker, code, sig) {

	logger.info(
		'Cluster process is exiting <signal: ' +
		sigCode.getNameByExitCode(code) + ', ' + sig +
		'> (worker: ' + worker.id + ') [pid: ' + worker.process.pid + ']: ' +
		Object.keys(cluster.workers).length + '/' + numOfWorkers 
	);

	// keep the copy
	var workerData = workerMap[worker.id];
	// remove from the map
	delete workerMap[worker.id];

	// this is for master process
	if (isReloading) {
		handleReloading();
		return;
	}
	// this is for master process
	if (!worker.suicide && autoSpawn) {
		handleAutoSpawn(worker, workerData, code, sig);
	}
	// this is for master process
	if (noMoreWorkers()) {
		// no more workers and shutting down
		// or no more workers with code greater than 0
		logger.info(
			'No more workers running (shutdown: ' + isShutdown +
			') [code: ' + sigCode.getNameByExitCode(code) + ', ' + code + ']'
		);
		if (isShutdown || code) {
			logger.info('All worker processes have disconnected');
			shutdown(null, code);
		}
		return;
	}
	
	// sync worker map with all workers
	syncWorkerMap();

	// worker disconnected for exit
	emitter.emit('workerExit');
}

function handleAutoSpawn(worker, workerData, code, sig) {
	// worker died from an error
	// auto-respawn the dead worker
	// if master wants to shutdown, workers don't auto re-spawn
	if (!isShutdown) {
		logger.error(
			'A worker process exited unexpectedly (worker: ' +
			worker.id + ') [pid: ' + workerData.pid + '] [code: ' +
			sigCode.getNameByExitCode(code) +
			'] [signal: ' + sig + ']'
		);
		if (Date.now() - workerData.started < MIN_LIFE) {
			// number of worker process has permanently decreased 
			numOfWorkers -= 1;
			logger.error(
				'A worker process must be alive for at least ' + MIN_LIFE + 'ms ' +
				' (ID: ' + worker.id + ') [pid: ' + worker.process.pid + ']' +
				'(# of worker: ' + numOfWorkers + '): auto-respawning ignored'
			);
			return;
		}
		var newWorker = createWorker();
		ee.emit('auto.spawn', newWorker.process.pid, newWorker.id);
	} else {
		logger.info(
			'Master process is instructing to shutdown (ID: ' + worker.id + ') [pid: ' +
			worker.process.pid + ']: no auto-respawning'
		);
	}
	return;
}

function handleReloading() {
	var worker = createWorker();

	emitter.emit('reloaded');
	
	reloaded += 1;
	
	logger.info(
		'Reloaded a worker process (ID: ' +
		worker.id + ') [pid: ' + worker.process.pid + ']'
	);

	ee.emit('reload', 'reloading', worker.process.pid, worker.id);
	ee.emit('reload.reloading', worker.pid, worker.id);

	// done and reset
	if (reloaded === numOfWorkers) {
		isReloading = false;
		reloaded = 0;
		ee.emit('reload', 'complete');
		ee.emit('reload.complete');
		logger.info('All worker processes have reloaded');
	}
}

function startWorker() {
	// set up message lsitener: master to worker
	process.on('message', function (data) {
		try {
			data = JSON.parse(data);
		} catch (e) {
			logger.warn('Message data not JSON:', data);
		}

		if (!data.command) {
			// not a command message
			return;
		}

		switch (data.command) {
			case CMD.EXIT:
				logger.info('Shutting down worker process for exit');
				shutdown(data.error || null);
				return;
			case CMD.RELOAD:
				logger.info('Shutting down worker process for reload');
				shutdown();
				return;
			case CMD.SYNC:
				logger.info('Synchronize worker map');
				logger.verbose('synched map:', data.map);
				workerMap = data.map;
				ee.emit('sync', workerMap);
				return;
			case CMD.MSG:
				ee.emit('message', { from: data.from, msg: data.msg });
				break;
			default:
				break;
		}
	});

	logger.info('Worker process started [pid: ' + process.pid + ']');
}

function reload() {

	if (!isMaster) {
		// this is master only
		return;
	}
	logger.info(
		'Reloading (# of workers: ' +
		Object.keys(cluster.workers).length + ')'
	);

	// more than 1 worker
	if (numOfWorkers) {
		// initialize flag and counter
		isReloading = true;
		reloaded = 0;
		// send reload command to each worker one at a time
		var keys = Object.keys(cluster.workers);
		var done = function () {
			// done
		};
		async.eachSeries(keys, function (id, next) {
			// this is the callback
			// when the worker is reloaded
			emitter.once('reloaded', next);
			// send reload command
			msg.send({ command: CMD.RELOAD }, cluster.workers[id]);
		}, done);
	}
}

function exit(errorExit, sig) {
	var print = (errorExit) ? (logger.fatal || logger.error) : logger.info;
	if (!isMaster) {
		// ask master to exit the process
		var e = null;
		if (errorExit) {
			e = {
				message: errorExit.message,
				stack: errorExit.stack
			};
		}
		msg.send({
			command: CMD.EXIT,
			error: e,
			sig: sig
		});
		return;
	}

	if (shutdownLock) {
		if (errorExit) {
			print('Exit instruction by error: ' + errorExit.message + '\n' + errorExit.stack);
		}
		return;
	}

	shutdownLock = true;
	
	if (errorExit) {
		print(
			'Exiting with an error [signal: ' + sig +
			' ' + sigCode.getNameByExitCode(sig) + '] (# of workers: ' +
			Object.keys(cluster.workers).length + '): ' + (errorExit.stack || null)
		);
	} else {
		print(
			'Exiting [signal: ' + sig + ' ' + sigCode.getNameByExitCode(sig) + '] (# of workers: ' +
			Object.keys(cluster.workers).length + ')'
		);
	}

	if (numOfWorkers && cluster.isMaster) {
		// master will wait for all workers to exit
		isShutdown = true;
		if (noMoreWorkers()) {
			// all workers have exited
			// now exit master
			print('Master is exiting');
			shutdown(sig);
			return;
		}
		// there are more workers
		// instruct them to disconnect and gracefuly exit
		var keys = Object.keys(cluster.workers);
		async.eachSeries(keys, function (id, next) {
			emitter.once('workerExit', next);
			print(
				'Instruct worker process to exit: ' +
				'(worker: ' + id + ') '
			);
			var e = null;
			if (errorExit) {
				e = {
					message: errorExit.message,
					stack: errorExit.stack
				};
			}
			msg.send({ command: CMD.EXIT, error: e }, cluster.workers[id]);
		});
		return;
	}
	// we don't have workers to begin with
	if (!numOfWorkers) {
		shutdown(errorExit, sig);
	}
}

function shutdown(errorShutdown, sig) {
	var print = (errorShutdown) ? (logger.fatal || logger.error) : logger.info;
	var counter = 0;
	var taskList = shutdownTasks.filter(function (item) {
		if (ee.isMaster()) {
			// run tasks with runOnMaster=true only on master
			return item.runOnMaster;
		} else {
			// run all tasks
			return true;
		}
	});
	var done = function (error) {
		var code = 0;
		if (error) {
			code = 1;
		}

		print('Exit [pid:', process.pid + ']');
		if (errorShutdown) {
			print(errorShutdown);
		}

		ee.emit('exit', code, sig || null);

		if (onExit) {
			onExit(function () {
				process.exit(code);
			});
			return;
		}
	
		process.exit(code);
	};

	logger.verbose(
		'Number of shutdown tasks before shutting down: ' +
		taskList.length
	);

	async.eachSeries(taskList, function (item, next) {

		counter += 1;

		print(
			'Execute shutdown task:',
			counter + ' out of ' + taskList.length
		);

		item.task(next);
	}, done);
}

function noMoreWorkers() {
	return !Object.keys(cluster.workers).length;
}
