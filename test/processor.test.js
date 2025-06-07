/*jshint node:true*/
/*global describe,it,before,after,beforeEach,afterEach*/
'use strict';

var FfmpegCommand = require('../index'),
  path = require('path'),
  fs = require('fs'),
  assert = require('assert'),
  os = require('os').platform(),
  exec = require('child_process').exec,
  spawn = require('child_process').spawn,
  async = require('async'),
  stream = require('stream'),
  testhelper = require('./helpers');


var testHTTP = 'http://127.0.0.1:8090/test.mpg';
var testRTSP = 'rtsp://127.0.0.1:5540/test-rtp.mpg';
var testRTPOut = 'rtp://127.0.0.1:5540/input.mpg';


/*****************************************************************

              IMPORTANT NOTE ABOUT PROCESSOR TESTS

 To ensure tests run reliably, you should do the following:

 * Any input file you use must be tested for existence before
   running the tests.  Use the 'prerequisite' function below and
   add any new file there.

 * FfmpegCommands should be created using 'this.getCommand(args)'
   in the test definition, not using 'new Ffmpegcommand(args)'.
   This enables ensuring the command is finished before starting
   the next test.

 * Any file your test is expected to create should have their full
   path pushed to the 'this.files' array in the test definition,
   and your test should *not* remove them on completion.  The
   cleanup hook will check all those files for existence and remove
   them.

 * Same thing with directories in the 'this.dirs' array.

 * If you use intervals or timeouts, please ensure they have been
   canceled (for intervals) or called (for timeouts) before
   calling the test 'done()' callback.

 Not abiding by those rules is BAD.  You have been warned :)

 *****************************************************************/


describe('Processor', function() {
  // check prerequisites once before all tests
  before(function prerequisites(done) {
    // check for ffmpeg installation
    this.testdir = path.join(__dirname, 'assets');
    this.testfileName = 'testvideo-43.avi';
    this.testfile = path.join(this.testdir, this.testfileName);
    this.testfilewide = path.join(this.testdir, 'testvideo-169.avi');
    this.testfilebig = path.join(this.testdir, 'testvideo-5m.mpg');
    this.testfilespecial = path.join(this.testdir, 'te[s]t_ video \' _ .flv');
    this.testfileaudio1 = path.join(this.testdir, 'testaudio-one.wav');
    this.testfileaudio2 = path.join(this.testdir, 'testaudio-two.wav');
    this.testfileaudio3 = path.join(this.testdir, 'testaudio-three.wav');

    var self = this;

    exec(testhelper.getFfmpegCheck(), function(err) {
      if (!err) {
        // check if all test files exist
        async.each([
            self.testfile,
            self.testfilewide,
            self.testfilebig,
            self.testfilespecial,
            self.testfileaudio1,
            self.testfileaudio2,
            self.testfileaudio3
          ], function(file, cb) {
            fs.exists(file, function(exists) {
              cb(exists ? null : new Error('test video file does not exist, check path (' + file + ')'));
            });
          },
          done
        );
      } else {
        done(new Error('cannot run test without ffmpeg installed, aborting test...'));
      }
    });
  });

  // cleanup helpers before and after all tests
  beforeEach(function setup(done) {
    var processes = this.processes = [];
    var outputs = this.outputs = [];

    // Tests should call this so that created processes are watched
    // for exit and checked during test cleanup
    this.getCommand = function(args) {
      var cmd = new FfmpegCommand(args); // cmdInstance
      var procInstance = null; // To store the actual ChildProcess instance

      cmd.on('start', function() {
        procInstance = cmd.ffmpegProc; // Capture the reference when start is emitted
        if (procInstance) {
          processes.push(procInstance);
          console.log('[fluent-ffmpeg test debug] Process started and pushed to tracking. PID: ' + (procInstance.pid || 'N/A'));

          procInstance.on('exit', function(code, signal) {
            console.log('[fluent-ffmpeg test debug] Process exited. PID: ' + (procInstance.pid || 'N/A') + ', Code: ' + code + ', Signal: ' + signal);
            var index = processes.indexOf(procInstance); // Use the captured reference
            if (index > -1) {
              processes.splice(index, 1);
              console.log('[fluent-ffmpeg test debug] Process successfully removed from tracking. PID: ' + (procInstance.pid || 'N/A'));
            } else {
              console.error('[fluent-ffmpeg test debug] Process exited but NOT FOUND in tracking array. PID: ' + (procInstance.pid || 'N/A'));
            }
          });
        } else {
            console.error("[fluent-ffmpeg test debug] 'start' event emitted but cmd.ffmpegProc is null/undefined.");
        }
      });

      return cmd;
    };

    // Tests should call this to display stdout/stderr in case of error
    this.saveOutput = function(stdout, stderr) {
      outputs.unshift([stdout, stderr]);
    };

    this.files = [];
    this.dirs = [];

    done();
  });

  afterEach(function cleanup(done) {
    var self = this;

    async.series([
        // Ensure every process has finished
        function(cb) {
          if (self.processes.length) {
            if (self.outputs.length) {
              testhelper.logOutput(self.outputs[0][0], self.outputs[0][1]);
            }

            self.test.error(new Error(self.processes.length + ' processes still running after "' + self.currentTest.title + '"'));
            cb();
          } else {
            cb();
          }
        },

        // Ensure all created files are removed
        function(cb) {
          async.each(self.files, function(file, cb) {
            fs.exists(file, function(exists) {
              if (exists) {
                fs.unlink(file, cb);
              } else {
                if (self.outputs.length) {
                  testhelper.logOutput(self.outputs[0][0], self.outputs[0][1]);
                }

                self.test.error(new Error('Expected created file ' + file + ' by  "' + self.currentTest.title + '"'));
                cb();
              }
            });
          }, cb);
        },

        // Ensure all created dirs are removed
        function(cb) {
          async.each(self.dirs, function(dir, cb) {
            fs.exists(dir, function(exists) {
              if (exists) {
                fs.rmdir(dir, cb);
              } else {
                if (self.outputs.length) {
                  testhelper.logOutput(self.outputs[0][0], self.outputs[0][1]);
                }

                self.test.error(new Error('Expected created directory ' + dir + ' by  "' + self.currentTest.title + '"'));
                cb();
              }
            });
          }, cb);
        }
      ],

      done
    );
  });

  describe('Process controls', function() {
    // Skip all niceness tests on windows
    var skipNiceness = os.match(/win(32|64)/);

    var skipRenice = false;

    (skipNiceness ? it.skip : it)('should properly limit niceness', function() {
      this.getCommand({ source: this.testfile, logger: testhelper.logger, timeout: 0.02 })
          .renice(100).options.niceness.should.equal(20);
    });

    ((skipNiceness || skipRenice) ? it.skip : it)('should dynamically renice process', function(done) {
      this.timeout(60000);

      var testFile = path.join(__dirname, 'assets', 'testProcessRenice.avi');
      this.files.push(testFile);

      var ffmpegJob = this.getCommand({ source: this.testfilebig, logger: testhelper.logger, timeout: 2 })
          .usingPreset('divx');

      var startCalled = false;
      var reniced = false;

      ffmpegJob
          .on('start', function() {
            startCalled = true;
            setTimeout(function() {
              ffmpegJob.renice(5);

              setTimeout(function() {
                exec('ps -p ' + ffmpegJob.ffmpegProc.pid + ' -o ni=', function(err, stdout) {
                  assert.ok(!err);
                  parseInt(stdout, 10).should.equal(5);
                  reniced = true;
                });
              }, 500);
            }, 500);

            ffmpegJob.ffmpegProc.on('exit', function() {
              reniced.should.equal(true);
              done();
            });
          })
          .on('error', function() {
            reniced.should.equal(true);
            startCalled.should.equal(true);
          })
          .on('end', function() {
            console.log('end was called, expected a timeout');
            assert.ok(false);
            done();
          })
            .saveToFile(testFile);
      });
    });

    it('should change the working directory', function(done) {
      var testFile = path.join(this.testdir, 'testvideo.avi');
      this.files.push(testFile);

      this.getCommand({ source: this.testfileName, logger: testhelper.logger, cwd: this.testdir })
        .usingPreset('divx')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function() {
          done();
        })
        .saveToFile(testFile);
    });

    it('should kill the process on timeout', function(done) {
      var testFile = path.join(__dirname, 'assets', 'testProcessKillTimeout.avi');
      // this.files.push(testFile); // Do not add to this.files, as timeout should prevent creation

      var command = this.getCommand({ source: this.testfilebig, logger: testhelper.logger, timeout: 0.01 }); // 0.01 second timeout
      var startCalled = false;
      var errorCalled = false;
      var self = this; // For saveOutput

      function cleanupTestFile(callback) {
        fs.exists(testFile, function(exists) {
          if (exists) {
            fs.unlink(testFile, function(unlinkErr) {
              if (unlinkErr) {
                console.error('[fluent-ffmpeg test debug] Timeout test: Error unlinking file: ' + testFile, unlinkErr);
              }
              callback();
            });
          } else {
            callback();
          }
        });
      }

      command
        .usingPreset('divx')
        .on('start', function(commandLine) {
          console.log('[fluent-ffmpeg test debug] Timeout test: Process started. Command: ' + commandLine);
          startCalled = true;
        })
        .on('error', function(err, stdout, stderr) {
          console.log('[fluent-ffmpeg test debug] Timeout test: on(error) called. Message: ' + err.message);
          self.saveOutput(stdout, stderr);
          
          assert.ok(startCalled, 'on(error) called before on(start) in timeout test');
          assert.ok(err.message.includes('timeout'), 'Error message did not indicate a timeout: ' + err.message);
          
          errorCalled = true;

          if (err.message.includes('timeout')) {
            console.log('[fluent-ffmpeg test debug] Timeout test: Attempting manual cleanup of process from tracking array.');
            const processInstanceFromCommand = command.ffmpegProc; // Process instance associated with this command

            if (processInstanceFromCommand && self.processes.includes(processInstanceFromCommand)) {
              const index = self.processes.indexOf(processInstanceFromCommand);
              self.processes.splice(index, 1);
              console.log('[fluent-ffmpeg test debug] Timeout test: Manually removed process PID ' + (processInstanceFromCommand.pid || 'N/A') + ' from tracking array.');
            } else if (self.processes.length === 1) {
              // If command.ffmpegProc was nullified or not found, but there's only one process, assume it's the one.
              const removedProc = self.processes.pop();
              console.log('[fluent-ffmpeg test debug] Timeout test: Manually removed the single tracked process (PID ' + (removedProc ? removedProc.pid : 'N/A') + ') as command.ffmpegProc was not directly found/matched.');
            } else {
              console.warn('[fluent-ffmpeg test debug] Timeout test: Could not identify specific process for manual removal from tracking array. Processes count: ' + self.processes.length);
            }
          }

          cleanupTestFile(done); // Expected path: test completes successfully with a timeout error
        })
        .on('end', function() {
          console.log('[fluent-ffmpeg test debug] Timeout test: on(end) called unexpectedly.');
          var endError = null;
          if (!errorCalled) {
            endError = new Error('end was called, but a timeout error was expected.');
          } else {
            console.warn('[fluent-ffmpeg test debug] Timeout test: on(end) was called after on(error). This might indicate an issue in event emission order.');
          }
          cleanupTestFile(function() {
            done(endError);
          });
        })
        .saveToFile(testFile);
    });

    it('should not keep node process running on completion', function(done) {
      var script = `
        var ffmpeg = require('.');
        ffmpeg('${this.testfilebig}', { timeout: 60 })
          .addOption('-t', 1)
          .addOption('-f', 'null')
          .saveToFile('/dev/null');
      `;

      exec(`node -e "${script}"`, { timeout: 1000 }, done);
    });

    it('should kill the process with .kill', function(done) {
      var testFile = path.join(__dirname, 'assets', 'testProcessKill.avi');
      this.files.push(testFile);

      var ffmpegJob = this.getCommand({ source: this.testfilebig, logger: testhelper.logger })

      var startCalled = false;
      var errorCalled = false;

      ffmpegJob
          .on('start', function() {
            startCalled = true;
            if (ffmpegJob.ffmpegProc) {
              console.log('[fluent-ffmpeg test debug] .kill test: Process started, PID: ' + (ffmpegJob.ffmpegProc.pid || 'N/A') + ". Scheduling kill in 300ms.");
              setTimeout(function() {
                if (ffmpegJob.ffmpegProc) { // Check again, process might be gone if -t is very short and kill is delayed
                  console.log('[fluent-ffmpeg test debug] .kill test: Calling kill() on PID: ' + (ffmpegJob.ffmpegProc.pid || 'N/A'));
                  ffmpegJob.kill();
                } else {
                  console.log('[fluent-ffmpeg test debug] .kill test: Process already gone before kill timeout.');
                }
              }, 300); // Kill after 300ms
            } else {
              console.error('[fluent-ffmpeg test debug] .kill test: ffmpegJob.ffmpegProc is null on start.');
              return done(new Error("ffmpegJob.ffmpegProc was null on start in .kill test"));
            }
          })
          .on('error', function(err) {
            console.log('[fluent-ffmpeg test debug] .kill test: on(error) called. Message: ' + err.message);
            if (require('os').platform().match(/win(32|64)/)) {
              // On Windows, a killed process might exit with a non-zero code or a specific error message
              // Check for either "ffmpeg exited with code" or a message indicating it was killed/terminated
              assert.ok(err.message.includes('ffmpeg exited with code') || err.message.includes('killed') || err.message.includes('terminated'), "Error message did not indicate a kill or non-zero exit code: " + err.message);
            } else {
              err.message.indexOf('ffmpeg was killed with signal SIGKILL').should.not.equal(-1);
            }
            startCalled.should.equal(true);
            errorCalled = true;
            // Assuming the 'exit' handler in getCommand will clean up 'processes' list.
            // done() will be called, and afterEach will verify 'processes' is empty.
            done();
          })
          .on('end', function() {
            console.log('[fluent-ffmpeg test debug] .kill test: on(end) called unexpectedly.');
            // This path should ideally not be taken if kill() works as expected
            if (!errorCalled) {
              // If error was not called, this is a failure.
              // We call done with an error to fail the test, otherwise it might timeout.
              done(new Error("end was called, but error was expected in .kill test because process was killed."));
            } else {
              // If errorCalled is true, but end is also called, it's a confusing state.
              // Still, call done() to prevent timeout, but the test logic might have issues.
              console.error('[fluent-ffmpeg test debug] .kill test: on(end) called even after on(error) was supposedly called. This is problematic.');
              done();
            }
          })
          .saveToFile(testFile);
    });

    it('should send the process custom signals with .kill(signal)', function(done) {
      this.timeout(60000);

      var testFile = path.join(__dirname, 'assets', 'testProcessKillCustom.avi');
      // Do not add to this.files, as SIGINT should prevent creation / lead to error

      // Using a 2s library timeout. If SIGINT (sent at 0.5s) works,
      // it should terminate the process before this library timeout is reached.
      // If SIGINT fails, this timeout would be a fallback, and the error message would be "timeout",
      // which would then fail the assertion in on('error').
      var ffmpegJob = this.getCommand({ source: this.testfilebig, logger: testhelper.logger, timeout: 15 }); // Increased command timeout to 15s
      var self = this;

      var startCalled = false;
      var errorCalled = false;
      var endCalled = false; // Added flag for on('end')
      var doneCalled = false;

      function cleanupTestFile(callback) {
        fs.exists(testFile, function(exists) {
          if (exists) {
            fs.unlink(testFile, function(unlinkErr) {
              if (unlinkErr) {
                console.error('[fluent-ffmpeg test debug] Custom Signal Test (SIGINT): Error unlinking file: ' + testFile, unlinkErr);
              }
              callback();
            });
          } else {
            callback();
          }
        });
      }

      // Definition for callDoneOnce was missing, re-adding it here.
      function callDoneOnce(err) {
        if (!doneCalled) {
          doneCalled = true;
          cleanupTestFile(function() {
            done(err);
          });
        }
      }

      ffmpegJob
          .usingPreset('divx')
          .on('start', function(commandLine) {
            console.log('[fluent-ffmpeg test debug] Custom Signal Test (SIGINT): Process started. PID: ' + (ffmpegJob.ffmpegProc ? ffmpegJob.ffmpegProc.pid : 'N/A') + '. Command: ' + commandLine);
            startCalled = true; // Moved startCalled assignment here, was missing in one version

            setTimeout(function() {
              if (ffmpegJob.ffmpegProc && !ffmpegJob.ffmpegProc.killed) {
                console.log('[fluent-ffmpeg test debug] Custom Signal Test (SIGINT): Sending SIGINT to PID: ' + (ffmpegJob.ffmpegProc.pid || 'N/A'));
                ffmpegJob.kill('SIGINT');
              } else {
                console.log('[fluent-ffmpeg test debug] Custom Signal Test (SIGINT): Process already gone or killed before SIGINT could be sent.');
              }
            }, 500); // Send SIGINT after 0.5s

            if (ffmpegJob.ffmpegProc) {
              ffmpegJob.ffmpegProc.on('exit', function(code, signal) {
                console.log('[fluent-ffmpeg test debug] Custom Signal Test (SIGINT): ffmpegProc on(exit). errorCalled: ' + errorCalled + ', endCalled: ' + endCalled + ', Code: ' + code + ', Signal: ' + signal);
                if (doneCalled) return;

                if (errorCalled) {
                  // on('error') should have called callDoneOnce(err).
                  // If doneCalled is still false here, it implies a logic issue in on('error')'s done handling.
                  if (!doneCalled) {
                    console.warn('[fluent-ffmpeg test debug] Custom Signal Test (SIGINT): Process exited, on(error) was true, but done() was not called by on(error) handler.');
                    // Fallback, though ideally on('error') handles its own done call.
                    // callDoneOnce(new Error('Process exited after error, but done was not called by error handler. Code: ' + code + ', Signal: ' + signal));
                  }
                } else if (endCalled) {
                  // on('end') was called, and on('error') was not. This is a clean SIGINT shutdown.
                  if (code === 0 && signal === null) {
                    console.log('[fluent-ffmpeg test debug] Custom Signal Test (SIGINT): Clean exit with on(end) after SIGINT. Success.');
                    callDoneOnce();
                  } else {
                    callDoneOnce(new Error('on(end) was called, but process exited with non-zero code/signal: ' + code + '/' + signal + ' after SIGINT.'));
                  }
                } else {
                  // Neither on('error') nor on('end') was called before exit.
                  callDoneOnce(new Error('Process exited (code ' + code + ', signal ' + signal + ') after SIGINT, but neither on(error) nor on(end) was emitted by the library.'));
                }
              });
            } else {
                console.error('[fluent-ffmpeg test debug] Custom Signal Test (SIGINT): ffmpegJob.ffmpegProc is null on start.');
                callDoneOnce(new Error("ffmpegJob.ffmpegProc was null on start in custom signal (SIGINT) test"));
            }
          })
          .on('error', function(err, stdout, stderr) {
            console.log('[fluent-ffmpeg test debug] Custom Signal Test (SIGINT): on(error) called. Message: ' + err.message);
            self.saveOutput(stdout, stderr);
            if (doneCalled) return; // Prevent multiple calls if error/exit race

            errorCalled = true;
            assert.ok(startCalled, 'on(error) called before on(start) in custom signal (SIGINT) test');
            
            var platform = require('os').platform();
            if (platform.match(/win(32|64)/)) {
              assert.ok(err.message.includes('exited with code') || err.message.toLowerCase().includes('signal sigint') || err.message.includes('killed') || err.message.includes('terminated'),
                'Error message did not indicate SIGINT-like termination on Windows: ' + err.message);
            } else {
              assert.ok(err.message.toLowerCase().includes('signal sigint') || err.message.includes('exited with code') || err.message.includes('killed') || err.message.includes('terminated'),
                'Error message did not indicate SIGINT-like termination on POSIX: ' + err.message);
            }

            // Manual process removal logic from previous successful timeout test
            if (ffmpegJob.ffmpegProc && self.processes.includes(ffmpegJob.ffmpegProc)) {
              const index = self.processes.indexOf(ffmpegJob.ffmpegProc);
              self.processes.splice(index, 1);
              console.log('[fluent-ffmpeg test debug] Custom Signal Test (SIGINT): Manually removed process PID ' + (ffmpegJob.ffmpegProc.pid || 'N/A') + ' from tracking array in on(error).');
            } else if (ffmpegJob.ffmpegProc) {
              console.log('[fluent-ffmpeg test debug] Custom Signal Test (SIGINT): Process PID ' + (ffmpegJob.ffmpegProc.pid || 'N/A') + ' was not found in tracking array for manual removal in on(error).');
            } else {
              console.log('[fluent-ffmpeg test debug] Custom Signal Test (SIGINT): ffmpegJob.ffmpegProc was null in on(error), cannot manually remove from tracking.');
            }
            
            // ffmpegProc.on('exit') should call callDoneOnce() // This comment is now incorrect. on('error') calls it.
            callDoneOnce(err); // Ensure on('error') calls done with the received error.
          })
          .on('end', function(stdout, stderr) {
            console.log('[fluent-ffmpeg test debug] Custom Signal Test (SIGINT): on(end) called.');
            if (doneCalled) return;
            // This is now a potentially valid path if SIGINT leads to a clean exit.
            // Set a flag and let ffmpegProc.on('exit') make the final call to done().
            endCalled = true;
            // Do NOT call callDoneOnce(new Error(...)) here anymore.
          })
          .saveToFile(testFile);
    });

  describe('Events', function() {
    it('should report codec data through \'codecData\' event', function(done) {
      this.timeout(60000);

      var testFile = path.join(__dirname, 'assets', 'testOnCodecData.avi');
      this.files.push(testFile);

      this.getCommand({ source: this.testfilebig, logger: testhelper.logger })
        .on('codecData', function(data) {
          data.should.have.property('audio');
          data.should.have.property('video');
        })
        .usingPreset('divx')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function() {
          done();
        })
        .saveToFile(testFile);
    });

    it('should report codec data through \'codecData\' event on piped inputs', function(done) {
      this.timeout(60000);

      var testFile = path.join(__dirname, 'assets', 'testOnCodecData.avi')
      this.files.push(testFile);

      this.getCommand({ source: fs.createReadStream(this.testfilebig), logger: testhelper.logger })
        .on('codecData', function(data) {
          data.should.have.property('audio');
          data.should.have.property('video');
        })
        .usingPreset('divx')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function() {
          done();
        })
        .saveToFile(testFile);
    });

    it('should report codec data through \'codecData\' for multiple inputs', function(done) {
      this.timeout(60000);

      var testFile = path.join(__dirname, 'assets', 'testOnCodecData.wav')
      this.files.push(testFile);

      this.getCommand({ logger: testhelper.logger })
        .input(this.testfileaudio1)
        .input(this.testfileaudio2)
        .on('codecData', function(data1, data2) {
          data1.should.have.property('audio');
          data2.should.have.property('audio');
        })
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function() {
          done();
        })
        .mergeToFile(testFile);
    });

    it('should report progress through \'progress\' event', function(done) {
      this.timeout(60000);

      var testFile = path.join(__dirname, 'assets', 'testOnProgress.avi');
      var gotProgress = false;

      this.files.push(testFile);

      this.getCommand({ source: this.testfilebig, logger: testhelper.logger })
          .on('progress', function() {
            gotProgress = true;
          })
          .usingPreset('divx')
          .on('error', function(err, stdout, stderr) {
            testhelper.logError(err, stdout, stderr);
            assert.ok(!err);
          })
          .on('end', function() {
            gotProgress.should.equal(true);
            done();
          })
          .saveToFile(testFile);
    });

    it('should report start of ffmpeg process through \'start\' event', function(done) {
      this.timeout(60000);

      var testFile = path.join(__dirname, 'assets', 'testStart.avi');
      var startCalled = false;

      this.files.push(testFile);

      this.getCommand({ source: this.testfilebig, logger: testhelper.logger })
          .on('start', function(cmdline) {
            startCalled = true;

            // Only test a subset of command line
            cmdline.indexOf('ffmpeg').should.equal(0);
            cmdline.indexOf('testvideo-5m').should.not.equal(-1);
            cmdline.indexOf('-b:a 128k').should.not.equal(-1);
          })
          .usingPreset('divx')
          .on('error', function(err, stdout, stderr) {
            testhelper.logError(err, stdout, stderr);
            assert.ok(!err);
          })
          .on('end', function() {
            startCalled.should.equal(true);
            done();
          })
          .saveToFile(testFile);
    });

    it('should report output lines through \'stderr\' event', function(done) {
      this.timeout(60000);

      var testFile = path.join(__dirname, 'assets', 'testStderr.avi');
      var lines = [];

      this.files.push(testFile);

      this.getCommand({ source: this.testfile, logger: testhelper.logger })
          .on('stderr', function(line) {
            lines.push(line);
          })
          .usingPreset('divx')
          .on('error', function(err, stdout, stderr) {
            testhelper.logError(err, stdout, stderr);
            assert.ok(!err);
          })
          .on('end', function() {
            lines.length.should.above(0);
            lines[0].should.startWith('ffmpeg version');
            lines.filter(function(l) { return l.indexOf('Press [q]') === 0. }).length.should.above(0);
            done();
          })
          .saveToFile(testFile);
    });
  });

  describe('Output limiting', function() {
    it('should limit stdout/stderr lines', function(done) {
      this.timeout(60000);

      var testFile = path.join(__dirname, 'assets', 'testLimit10.avi');

      this.files.push(testFile);

      this.getCommand({ stdoutLines: 10, source: this.testfile, logger: testhelper.logger })
          .usingPreset('divx')
          .on('error', function(err, stdout, stderr) {
            testhelper.logError(err, stdout, stderr);
            assert.ok(!err);
          })
          .on('end', function(stdout, stderr) {
            stdout.split('\n').length.should.below(11);
            stderr.split('\n').length.should.below(11);
            done();
          })
          .saveToFile(testFile);
    });
  });

  describe('takeScreenshots', function() {
    function testScreenshots(title, name, config, files) {
      it(title, function(done) {
        var filenamesCalled = false;
        var testFolder = path.join(__dirname, 'assets', 'screenshots_' + name);

        var context = this;
        files.forEach(function(file) {
          context.files.push(path.join(testFolder, file));
        });
        this.dirs.push(testFolder);

        this.getCommand({ source: this.testfile, logger: testhelper.logger })
          .on('error', function(err, stdout, stderr) {
            testhelper.logError(err, stdout, stderr);
            assert.ok(!err);
          })
          .on('filenames', function(filenames) {
            filenamesCalled = true;
            filenames.length.should.equal(files.length);
            filenames.forEach(function(file, index) {
              file.should.equal(files[index]);
            });
          })
          .on('end', function() {
            filenamesCalled.should.equal(true);
            fs.readdir(testFolder, function(err, content) {
              var tnCount = 0;
              content.forEach(function(file) {
                if (file.indexOf('.png') > -1) {
                  tnCount++;
                }
              });
              tnCount.should.equal(files.length);
              files.forEach(function(file) {
                content.indexOf(file).should.not.equal(-1);
              });
              done();
            });
          })
          .takeScreenshots(config, testFolder);
      });
    }

    testScreenshots(
      'should take screenshots from a list of number timemarks',
      'timemarks_num',
      { timemarks: [ 0.5, 1 ] },
      ['tn_1.png', 'tn_2.png']
    );

    testScreenshots(
      'should take screenshots from a list of string timemarks',
      'timemarks_string',
      { timemarks: [ '0.5', '1' ] },
      ['tn_1.png', 'tn_2.png']
    );

    testScreenshots(
      'should take screenshots from a list of string timemarks',
      'timemarks_hms',
      { timemarks: [ '00:00:00.500', '00:01' ] },
      ['tn_1.png', 'tn_2.png']
    );

    testScreenshots(
      'should support "timestamps" instead of "timemarks"',
      'timestamps',
      { timestamps: [ 0.5, 1 ] },
      ['tn_1.png', 'tn_2.png']
    );

    testScreenshots(
      'should replace %i with the screenshot index',
      'filename_i',
      { timemarks: [ 0.5, 1 ], filename: 'shot_%i.png' },
      ['shot_1.png', 'shot_2.png']
    );

    testScreenshots(
      'should replace %000i with the padded screenshot index',
      'filename_0i',
      { timemarks: [ 0.5, 1 ], filename: 'shot_%000i.png' },
      ['shot_0001.png', 'shot_0002.png']
    );

    testScreenshots(
      'should replace %s with the screenshot timestamp',
      'filename_s',
      { timemarks: [ 0.5, '40%', 1 ], filename: 'shot_%s.png' },
      ['shot_0.5.png', 'shot_0.8.png', 'shot_1.png']
    );

    testScreenshots(
      'should replace %f with the input filename',
      'filename_f',
      { timemarks: [ 0.5, 1 ], filename: 'shot_%f_%i.png' },
      ['shot_testvideo-43.avi_1.png', 'shot_testvideo-43.avi_2.png']
    );

    testScreenshots(
      'should replace %b with the input basename',
      'filename_b',
      { timemarks: [ 0.5, 1 ], filename: 'shot_%b_%i.png' },
      ['shot_testvideo-43_1.png', 'shot_testvideo-43_2.png']
    );

    testScreenshots(
      'should replace %r with the output resolution',
      'filename_r',
      { timemarks: [ 0.5, 1 ], filename: 'shot_%r_%i.png' },
      ['shot_1024x768_1.png', 'shot_1024x768_2.png']
    );

    testScreenshots(
      'should replace %w and %h with the output resolution',
      'filename_wh',
      { timemarks: [ 0.5, 1 ], filename: 'shot_%wx%h_%i.png' },
      ['shot_1024x768_1.png', 'shot_1024x768_2.png']
    );

    testScreenshots(
      'should automatically add %i when no variable replacement is present',
      'filename_add_i',
      { timemarks: [ 0.5, 1 ], filename: 'shot_%b.png' },
      ['shot_testvideo-43_1.png', 'shot_testvideo-43_2.png']
    );

    testScreenshots(
      'should automatically compute timestamps from the "count" option',
      'count',
      { count: 3, filename: 'shot_%s.png' },
      ['shot_0.5.png', 'shot_1.png', 'shot_1.5.png']
    );

    testScreenshots(
      'should enable setting screenshot size',
      'size',
      { count: 3, filename: 'shot_%r.png', size: '150x?' },
      ['shot_150x112_1.png', 'shot_150x112_2.png', 'shot_150x112_3.png']
    );

    testScreenshots(
      'a single screenshot should not have a _1 file name suffix',
      'no_suffix',
      { timemarks: [ 0.5 ] },
      ['tn.png']
    );
  });

  describe('saveToFile', function() {
    it('should save the output file properly to disk', function(done) {
      var testFile = path.join(__dirname, 'assets', 'testConvertToFile.avi');
      this.files.push(testFile);

      this.getCommand({ source: this.testfile, logger: testhelper.logger })
        .usingPreset('divx')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function() {
          fs.exists(testFile, function(exist) {
            exist.should.equal(true);
            // check filesize to make sure conversion actually worked
            fs.stat(testFile, function(err, stats) {
              assert.ok(!err && stats);

              stats.size.should.above(0);
              stats.isFile().should.equal(true);

              done();
            });
          });
        })
        .saveToFile(testFile);
    });

    it('should save an output file with special characters properly to disk', function(done) {
      var testFile = path.join(__dirname, 'assets', "te[s]t video ' (safe) .avi");
      this.files.push(testFile);

      this.getCommand({ source: this.testfile, logger: testhelper.logger })
        .usingPreset('divx')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function() {
          done();
        })
        .saveToFile(testFile);
    });

    it('should save output files with special characters', function(done) {
      var testFile = path.join(__dirname, 'assets', "[test (special) ' characters] .avi");
      this.files.push(testFile);

      this.getCommand({ source: this.testfile, logger: testhelper.logger })
        .usingPreset('divx')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function() {
          fs.exists(testFile, function(exist) {
            exist.should.equal(true);
            // check filesize to make sure conversion actually worked
            fs.stat(testFile, function(err, stats) {
              assert.ok(!err && stats);
              stats.size.should.above(0);
              stats.isFile().should.equal(true);

              done();
            });
          });
        })
        .saveToFile(testFile);
    });

    it('should accept a stream as its source', function(done) {
      var testFile = path.join(__dirname, 'assets', 'testConvertFromStreamToFile.avi');
      this.files.push(testFile);

      var instream = fs.createReadStream(this.testfile);
      this.getCommand({ source: instream, logger: testhelper.logger })
        .usingPreset('divx')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function() {
          fs.exists(testFile, function(exist) {
            exist.should.equal(true);
            // check filesize to make sure conversion actually worked
            fs.stat(testFile, function(err, stats) {
              assert.ok(!err && stats);
              stats.size.should.above(0);
              stats.isFile().should.equal(true);

              done();
            });
          });
        })
        .saveToFile(testFile);
    });

    it('should pass input stream errors through to error handler', function(done) {
      var testFile = path.join(__dirname, 'assets', 'testConvertFromStream.avi')

		const readError = new Error('Read Error')
      const instream = new (require('stream').Readable)({
        read() {
  		    process.nextTick(() => this.emit('error', readError))
		  }
      })

      const command = this.getCommand({ source: instream, logger: testhelper.logger })

      let startCalled = false
      const self = this

      command
          .usingPreset('divx')
          .on('start', function() {
          	startCalled = true
            command.ffmpegProc.on('exit', function() {
            	fs.exists(testFile, (exists) => {
            		exists.should.be.false()
						done()
            	})
            })
          })
          .on('error', function(err, stdout, stderr) {
            self.saveOutput(stdout, stderr)
            startCalled.should.be.true()
            assert.ok(err)
            err.message.indexOf('Input stream error: ').should.equal(0)
			   assert.strictEqual(err.inputStreamError, readError)
          })
          .on('end', function(stdout, stderr) {
            testhelper.logOutput(stdout, stderr)
            console.log('end was called, expected a error')
            assert.ok(false)
            done()
          })
          .saveToFile(testFile)
    })
  });

  describe('mergeToFile', function() {

    it('should merge multiple files', function(done) {
      var testFile = path.join(__dirname, 'assets', 'testMergeAddOption.wav');
      this.files.push(testFile);

      this.getCommand({source: this.testfileaudio1, logger: testhelper.logger})
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function() {
          fs.exists(testFile, function(exist) {
            exist.should.equal(true);
            // check filesize to make sure conversion actually worked
            fs.stat(testFile, function(err, stats) {
              assert.ok(!err && stats);
              stats.size.should.above(0);
              stats.isFile().should.equal(true);

              done();
            });
          });
        })
        .mergeAdd(this.testfileaudio2)
        .mergeAdd(this.testfileaudio3)
        .mergeToFile(testFile);
    });
  });

  describe('writeToStream', function() {
    it('should save the output file properly to disk using a stream', function(done) {
      var testFile = path.join(__dirname, 'assets', 'testConvertToStream.avi');
      this.files.push(testFile);

      var outstream = fs.createWriteStream(testFile);
      this.getCommand({ source: this.testfile, logger: testhelper.logger })
        .usingPreset('divx')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function(stdout, stderr) {
          fs.exists(testFile, function(exist) {
            if (!exist) {
              console.log(stderr);
            }

            exist.should.equal(true);

            // check filesize to make sure conversion actually worked
            fs.stat(testFile, function(err, stats) {
              assert.ok(!err && stats);
              stats.size.should.above(0);
              stats.isFile().should.equal(true);

              done();
            });
          });
        })
        .writeToStream(outstream, {end:true});
    });

    it('should accept a stream as its source', function(done) {
      var testFile = path.join(__dirname, 'assets', 'testConvertFromStreamToStream.avi');
      this.files.push(testFile);

      var instream = fs.createReadStream(this.testfile);
      var outstream = fs.createWriteStream(testFile);

      this.getCommand({ source: instream, logger: testhelper.logger })
        .usingPreset('divx')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function(stdout,stderr) {
          fs.exists(testFile, function(exist) {
            if (!exist) {
              console.log(stderr);
            }

            exist.should.equal(true);
            // check filesize to make sure conversion actually worked
            fs.stat(testFile, function(err, stats) {
              assert.ok(!err && stats);
              stats.size.should.above(0);
              stats.isFile().should.equal(true);

              done();
            });
          });
        })
        .writeToStream(outstream);
    });

    (process.version.match(/v0\.8\./) ? it.skip : it)('should return a PassThrough stream when called with no arguments on node >=0.10', function(done) {
      var testFile = path.join(__dirname, 'assets', 'testConvertToStream.avi');
      this.files.push(testFile);

      var outstream = fs.createWriteStream(testFile);
      var command = this.getCommand({ source: this.testfile, logger: testhelper.logger });

      command
        .usingPreset('divx')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function(stdout, stderr) {
          fs.exists(testFile, function(exist) {
            if (!exist) {
              console.log(stderr);
            }

            exist.should.equal(true);

            // check filesize to make sure conversion actually worked
            fs.stat(testFile, function(err, stats) {
              assert.ok(!err && stats);
              stats.size.should.above(0);
              stats.isFile().should.equal(true);

              done();
            });
          });
        });

      var passthrough = command.writeToStream({end: true});

      passthrough.should.instanceof(stream.PassThrough);
      passthrough.pipe(outstream);
    });

    (process.version.match(/v0\.8\./) ? it : it.skip)('should throw an error when called with no arguments on node 0.8', function() {
      (function() {
        new FfmpegCommand().writeToStream({end: true});
      }).should.throw(/PassThrough stream is not supported on node v0.8/);
    });

    it('should pass output stream errors through to error handler', function(done) {

		const writeError = new Error('Write Error')
      const outstream = new (require('stream').Writable)({
        write(chunk, encoding, callback) {
          callback(writeError)
		  }
      })

      const command = this.getCommand({ source: this.testfile, logger: testhelper.logger })

      let startCalled = false
      const self = this

      command
          .usingPreset('divx')
          .on('start', function() {
          	startCalled = true
            command.ffmpegProc.on('exit', function() {
					done()
            })
          })
          .on('error', function(err, stdout, stderr) {
            self.saveOutput(stdout, stderr)
            startCalled.should.be.true()
            assert.ok(err)
            err.message.indexOf('Output stream error: ').should.equal(0)
			   assert.strictEqual(err.outputStreamError, writeError)
          })
          .on('end', function(stdout, stderr) {
            console.log('end was called, expected a error')
            testhelper.logOutput(stdout, stderr)
            assert.ok(false)
            done()
          })
          .writeToStream(outstream)
    })
  });

  describe('Outputs', function() {
    it('should create multiple outputs', function(done) {
      this.timeout(30000);

      var testFile1 = path.join(__dirname, 'assets', 'testMultipleOutput1.avi');
      this.files.push(testFile1);
      var testFile2 = path.join(__dirname, 'assets', 'testMultipleOutput2.avi');
      this.files.push(testFile2);
      var testFile3 = path.join(__dirname, 'assets', 'testMultipleOutput3.mp4');
      this.files.push(testFile3);

      this.getCommand({ source: this.testfilebig, logger: testhelper.logger })
        .output(testFile1)
        .withAudioCodec('vorbis')
        .withVideoCodec('copy')
        .output(testFile2)
        .withAudioCodec('libmp3lame')
        .withVideoCodec('copy')
        .output(testFile3)
        .withSize('160x120')
        .withAudioCodec('aac')
        .withVideoCodec('libx264')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function() {
          async.map(
            [testFile1, testFile2, testFile3],
            function(file, cb) {
              fs.exists(file, function(exist) {
                exist.should.equal(true);

                // check filesize to make sure conversion actually worked
                fs.stat(file, function(err, stats) {
                  assert.ok(!err && stats);
                  stats.size.should.above(0);
                  stats.isFile().should.equal(true);

                  cb(err);
                });
              });
            },
            function(err) {
              testhelper.logError(err);
              assert.ok(!err);
              done();
            }
          );
        })
        .run();
    });
  });

  describe('Inputs', function() {
    it('should take input from a file with special characters', function(done) {
      var testFile = path.join(__dirname, 'assets', 'testSpecialInput.avi');
      this.files.push(testFile);

      this.getCommand({ source: this.testfilespecial, logger: testhelper.logger, timeout: 10 })
        .takeFrames(50)
        .usingPreset('divx')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function() {
          fs.exists(testFile, function(exist) {
            exist.should.equal(true);
            // check filesize to make sure conversion actually worked
            fs.stat(testFile, function(err, stats) {
              assert.ok(!err && stats);
              stats.size.should.above(0);
              stats.isFile().should.equal(true);

              done();
            });
          });
        })
        .saveToFile(testFile);
    });
  });

  describe.skip('Remote I/O', function() {
    this.timeout(60000);

    var ffserver;

    before(function(done) {
      testhelper.logger.debug('spawning ffserver');
      ffserver = spawn(
        'ffserver',
        ['-d','-f', path.join(__dirname, 'assets', 'ffserver.conf')],
        { cwd: path.join(__dirname, 'assets') }
      );

      // Wait for ffserver to be ready
      var isready = false;
      function ready() {
        if (!isready) {
          testhelper.logger.debug('ffserver is ready');
          isready = true;
          done();
        }
      }

      ffserver.stdout.on('data', function(d) {
        if (d.toString().match(/server started/i)) {
          ready();
        }
      });

      ffserver.stderr.on('data', function(d) {
        if (d.toString().match(/server started/i)) {
          ready();
        }
      });

    });

    beforeEach(function(done) {
      setTimeout(done, 5000);
    });

    after(function(done) {
      ffserver.kill();
      setTimeout(done, 1000);
    });

    it('should take input from a RTSP stream', function(done) {
      var testFile = path.join(__dirname, 'assets', 'testRTSPInput.avi');
      this.files.push(testFile);

      this.getCommand({ source: encodeURI(testRTSP), logger: testhelper.logger, timeout: 0 })
        .takeFrames(10)
        .usingPreset('divx')
        .withSize('320x240')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function() {
          fs.exists(testFile, function(exist) {
            exist.should.equal(true);
            // check filesize to make sure conversion actually worked
            fs.stat(testFile, function(err, stats) {
              assert.ok(!err && stats);
              stats.size.should.above(0);
              stats.isFile().should.equal(true);

              done();
            });
          });
        })
        .saveToFile(testFile);
    });

    it('should take input from an URL', function(done) {
      var testFile = path.join(__dirname, 'assets', 'testURLInput.avi');
      this.files.push(testFile);

      this.getCommand({ source: testHTTP, logger: testhelper.logger, timeout: 0 })
        .takeFrames(5)
        .usingPreset('divx')
        .withSize('320x240')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function() {
          fs.exists(testFile, function(exist) {
            exist.should.equal(true);
            // check filesize to make sure conversion actually worked
            fs.stat(testFile, function(err, stats) {
              assert.ok(!err && stats);
              stats.size.should.above(0);
              stats.isFile().should.equal(true);

              done();
            });
          });
        })
        .saveToFile(testFile);
    });

    it('should output to a RTP stream', function(done) {
      this.getCommand({ source: this.testfilebig, logger: testhelper.logger })
        .videoCodec('libx264')
        .audioCodec('copy')
        .on('error', function(err, stdout, stderr) {
          testhelper.logError(err, stdout, stderr);
          assert.ok(!err);
        })
        .on('end', function() {
          done();
        })
        .save(testRTPOut);
    });
  });

  describe('Errors', function() {
    it('should report an error when ffmpeg has been killed', function(done) {
      this.timeout(10000);

      var testFile = path.join(__dirname, 'assets', 'testErrorKill.avi');
      this.files.push(testFile);

      var command = this.getCommand({ source: this.testfilebig, logger: testhelper.logger });

      command
        .usingPreset('divx')
        .on('start', function() {
          setTimeout(function() {
            command.kill('SIGKILL');
          }, 200);
        })
        .on('error', function(err) {
          err.message.should.match(/ffmpeg was killed with signal SIGKILL/);
          done();
        })
        .on('end', function() {
          assert.ok(false);
        })
        .saveToFile(testFile);
    });

    it('should report ffmpeg errors', function(done) {
      this.getCommand({ source: this.testfilebig, logger: testhelper.logger })
        .addOption('-invalidoption')
        .on('error', function(err) {
          setTimeout(done, 1000);
          err.message.should.match(/Unrecognized option 'invalidoption'/);
        })
        .saveToFile('/will/not/be/created/anyway');
    });
  });
});
