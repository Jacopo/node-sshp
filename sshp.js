#!/usr/bin/env node
/**
 * Parallel SSH
 *
 * simple, intuitive, no bullshit parallel ssh
 *
 * Author: Dave Eddy <dave@daveeddy.com>
 * Date: 1/18/2013
 * License: MIT
 */

var child_process = require('child_process');
var fs = require('fs');
var util = require('util');

var async = require('async');
var getopt = require('posix-getopt');
var ll = require('lazylines');

var package = require('./package.json');

require('colors');

/**
 * Usage
 *
 * return the usage message
 */
function usage() {
  return [
    'Usage: sshp [-m maxjobs] [-f file] command ...',
    '',
    'parallel ssh with streaming output',
    '',
    'examples',
    '  ssh into a list of hosts passed via stdin and get the output of `uname -v`',
    '',
    '    sshp uname -v < hosts',
    '',
    '  ssh into a list of hosts passed on the command line, limit max parallel',
    '  connections to 3, and grab the output of ps piped to grep on the remote end',
    '',
    '    sshp -m 3 -f my_hosts.txt "ps -ef | grep process"',
    '',
    'options',
    '  -d, --debug       turn on debugging information, defaults to false',
    '  -e, --exit-codes  print the exit code of the remote processes, defaults to false',
    '  -f, --file        a file of hosts separated by newlines, defaults to stdin',
    '  -g, --group       group the output together as it comes in by hostname, not line-by-line',
    '  -h, --help        print this message and exit',
    '  -j, --join        join hosts together by unique output',
    '  -m, --max-jobs    the maximum number of jobs to run concurrently, defaults to 30',
    '  -n, --dry-run     print debug information without actually running any commands',
    '  -N, --no-strict   disable strict host key checking for ssh, defaults to false',
    '  -s, --silent      silence all stdout and stderr from remote hosts, defaults to false',
    '  -u, --updates     check for available updates',
    '  -v, --version     print the version number and exit',
    '',
    'ssh options (options passed directly to ssh)',
    '  -i, --identity    ssh identity file to use',
    '  -l, --login       the username to login as',
    '  -q, --quiet       run ssh in quiet mode',
    '  -p, --port        the ssh port',
  ].join('\n');
}

// verbose log
function vlog() {
  if (!debug) return;
  var s = util.format.apply(this, arguments);
  console.log('[%s] %s', 'sshp'.cyan, s);
}

// wrapper for util.inspect for array
function insarray(arr) {
  var items = [];
  arr.forEach(function(item) {
    items.push(util.inspect(item, false, null, true));
  });
  return util.format('[ %s ]', items.join(', '));
}

// print progress
function progress(cr) {
  process.stdout.write(util.format('[%s] finished %s/%s%s',
      'sshp'.cyan,
      ('' + i).magenta,
      ('' + hosts.length).magenta,
      cr ? '\r' : '\n'
  ));
}

// command line arguments
var options = [
  'd(debug)',
  'e(exit-codes)',
  'f:(file)',
  'g(group)',
  'h(help)',
  'i:(identity)',
  'j(join)',
  'l:(login)',
  'm:(max-jobs)',
  'n(dry-run)',
  'N(no-strict)',
  'p:(port)',
  'q(quiet)',
  's(silent)',
  'u(updates)',
  'v(version)'
].join('');
var parser = new getopt.BasicParser(options, process.argv);

var option;
var debug = false;
var dryrun = false;
var errorcodes = false;
var file;
var group = false;
var join = false;
var login;
var maxjobs = 30;
var nostrict = false;
var port;
var quiet = false;
var silent = false;
while ((option = parser.getopt()) !== undefined) {
  switch (option.option) {
    case 'd': debug = true; break;
    case 'e': errorcodes = true; break;
    case 'f': file = option.optarg; break;
    case 'g': group = true; break;
    case 'h': console.log(usage()); process.exit(0);
    case 'i': identity = option.optarg; break;
    case 'j': join = true; break;
    case 'l': login = option.optarg; break;
    case 'm': maxjobs = +option.optarg; break;
    case 'n': dryrun = true; debug = true; break;
    case 'N': nostrict = true; break;
    case 'p': port = +option.optarg; break;
    case 'q': quiet = true; break;
    case 's': silent = true; break;
    case 'u': // check for updates
      require('latest').checkupdate(package, function(ret, msg) {
        console.log(msg);
        process.exit(ret);
      });
      return;
    case 'v': console.log(package.version); process.exit(0);
    default: console.error(usage()); process.exit(1); break;
  }
}
var command = process.argv.slice(parser.optind());
if (!command.length) {
  console.error('no command specified');
  process.exit(1);
} else if (group && join) {
  console.error('option `-g` and `-j` are mutually exclusive');
  process.exit(1);
} else if (join && silent) {
  console.error('option `-j` and `-s` are mutually exclusive');
  process.exit(1);
}

// read the hosts
file = file || '/dev/stdin';
var hosts = fs.readFileSync(file, 'utf-8').split('\n').filter(function(a) { return a; });

var progstart = new Date();
vlog('starting: %s', progstart.toISOString());
vlog('pid: %s', ('' + process.pid).magenta);
vlog('hosts (%s): %s', ('' + hosts.length).magenta, insarray(hosts));
vlog('command: %s', insarray(command));
vlog('maxjobs: %s', ('' + maxjobs).green);

// construct the SSH command
var sshcommand = ['ssh'];
if (quiet) sshcommand.push('-q');
if (port) sshcommand.push('-p', port);
if (login) sshcommand.push('-l', login);
if (nostrict) sshcommand.push('-o', 'StrictHostKeyChecking=no');

// make a queue
var q = async.queue(processhost, maxjobs);

// store output
var output = {};

// loop the hosts and go!
hosts.forEach(function(host) {
  output[host] = '';
  q.push(host, function() {});
});
q.drain = function() {
  var progend = new Date();
  var delta = progend - progstart;

  if (join && !group) {
    // figure out what hosts had matching output
    var diff = {};
    var outputkeys = Object.keys(output);
    outputkeys.forEach(function(host) {
      var text = output[host];
      diff[text] = diff[text] || [];
      diff[text].push(host);
    });

    var keys = Object.keys(diff);
    console.log('\n\nfinished with %s unique result%s\n',
        ('' + keys.length).magenta,
        keys.length === 1 ? '' : 's'
    );
    keys.forEach(function(text) {
      var hosts = diff[text];
      console.log('hosts (%d/%d): %s'.grey,
          hosts.length,
          outputkeys.length,
          hosts.join(' ').cyan
      );
      console.log(text || 'no output\n'.grey);
    });
  }

  vlog('finished: %s (%s ms)', progend.toISOString(), ('' + delta).magenta);
  process.exit(exitcode);
};

var exitcode = 0;
var lasthost;

// dump progess on SIGUSR1
process.on('SIGUSR1', progress);

var i = 0;
// the function the queue should call for each host
function processhost(host, cb) {
  var started = new Date();
  var cmd = sshcommand.concat(host, command);
  vlog('[%s] %s', host.yellow, insarray(cmd));
  if (dryrun) return cb();

  var child = child_process.spawn(cmd[0], cmd.slice(1));

  // hook up stdout
  if (group || join) {
    child.stdout.on('data', out)
  } else {
    var stdout = new ll.LineReadStream(child.stdout);
    stdout.on('line', out);
  }
  function out(d) {
    if (silent) return;
    d = d.toString();

    if (group) {
      if (host !== lasthost) {
        console.log('[%s] ', host.cyan);
        lasthost = host;
      }
      process.stdout.write(d.green);
    } else if (join) {
      output[host] = output[host] || '';
      output[host] += d;
    } else {
      line = ll.chomp(d);
      console.log('[%s] %s', host.cyan, line.green);
    }
  }

  // hook up stderr
  if (group || join) {
    child.stderr.on('data', err);
  } else {
    var stderr = new ll.LineReadStream(child.stderr);
    stderr.on('line', err);
  }
  function err(d) {
    if (silent) return;
    d = d.toString();

    if (group) {
      if (host !== lasthost) {
        console.log('[%s] ', host.cyan);
        lasthost = host;
      }
      process.stderr.write(d.red);
    } else if (join) {
      output[host] = output[host] || '';
      output[host] += d;
    } else {
      line = ll.chomp(d);
      console.error('[%s] %s', host.cyan, line.red);
    }
  }

  // capture the exit
  child.on('close', function(code) {
    ++i;
    exitcode += code;
    if (errorcodes) {
      var delta = new Date() - started;
      console.log('[%s] exited: %s (%s ms)',
          host.cyan,
          code === 0 ? ('' + code).green : ('' + code).red,
          ('' + delta).magenta
      );
    } else if (join) {
      progress(true);
    }
    cb();
  });
}

if (join) progress(true);
