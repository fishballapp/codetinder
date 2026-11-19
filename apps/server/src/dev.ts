import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import { RoundStore } from './round-store';
import { serve } from './serve';
import { SweepStore } from './sweep-store';

// Local: rounds and sweeps in memory, readable logs; GitLab is the real one.
Layer.launch(
  serve({
    stores: Layer.mergeAll(RoundStore.memory, SweepStore.memory),
    logger: Logger.layer([Logger.consolePretty()]),
  }),
).pipe(NodeRuntime.runMain);
