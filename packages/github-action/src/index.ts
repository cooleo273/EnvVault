import * as core from '@actions/core';
import { run } from './main.js';

process.exitCode = await run({
  getInput: (name) => core.getInput(name),
  getIDToken: (audience) => core.getIDToken(audience),
  setSecret: (value) => {
    core.setSecret(value);
  },
  setOutput: (name, value) => {
    core.setOutput(name, value);
  },
  info: (message) => {
    core.info(message);
  },
  warning: (message) => {
    core.warning(message);
  },
  setFailed: (message) => {
    core.setFailed(message);
  },
  env: process.env,
});
