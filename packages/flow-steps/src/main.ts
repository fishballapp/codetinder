#!/usr/bin/env node
import './polyfills';
import { oneLine } from '@codetinder/core';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Cause from 'effect/Cause';
import * as CliConfig from 'effect/cli/CliConfig';
import * as Command from 'effect/cli/Command';
import * as GlobalFlag from 'effect/cli/GlobalFlag';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { proposeCommand } from './propose';
import { renderCommand } from './render';
import { roundCommand } from './round';
import { routeCommand } from './route';
import { logSession } from './session-log';
import { sweepCommand } from './sweep';
import { taskCommand } from './task';
import { messageOf } from './user-error';
import { verifyCommand } from './verify';

// A flow's sandbox reaches the internet only through HTTPS_PROXY, which Node 20's fetch ignores.
// Without a proxy in the environment this agent connects directly.
setGlobalDispatcher(new EnvHttpProxyAgent());

const VERSION = '0.0.0';

const flowSteps = Command.make('flow-steps').pipe(
  Command.withDescription(
    "The CodeTinder Duo flow's deterministic steps. Internal: run by the flow, not by people.",
  ),
  Command.withSubcommands([
    routeCommand,
    taskCommand,
    roundCommand,
    renderCommand,
    verifyCommand,
    proposeCommand,
    sweepCommand,
  ]),
);

flowSteps.pipe(
  Command.run({ version: VERSION }),
  // A step that fails says so on the session page too, not only in its own log.
  Effect.tapCause(cause => logSession(`A step failed: ${oneLine(messageOf(Cause.squash(cause)))}`)),
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
    ),
  ),
  NodeRuntime.runMain,
);
