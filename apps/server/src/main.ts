import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import { RoundStore } from './round-store';
import { serve } from './serve';
import { SweepStore } from './sweep-store';

// Cloud Run: Firestore, and JSON logs for Cloud Logging.
Layer.launch(
  serve({
    stores: Layer.mergeAll(RoundStore.firestore, SweepStore.firestore),
    logger: Logger.layer([Logger.consoleJson]),
  }),
).pipe(NodeRuntime.runMain);
