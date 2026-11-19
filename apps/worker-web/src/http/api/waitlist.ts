/** `/api/waitlist` (`Waitlist`). */
import { WaitlistApi } from '@codetinder/api/waitlist';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { Waitlist } from '../../services/waitlist';

export const WaitlistHandlers = HttpApiBuilder.group(
  WaitlistApi,
  'waitlist',
  Effect.fn(function* (handlers) {
    const waitlist = yield* Waitlist;
    return handlers.handleAll({
      join: Effect.fn(function* ({ payload }) {
        // A bot that filled the hidden field is told it worked and stored nowhere.
        if (payload.website !== undefined && payload.website !== '') return { status: 'joined' };
        yield* waitlist.join({
          email: payload.email,
          platform: payload.platform,
          consentVersion: payload.consent,
        });
        return { status: 'joined' };
      }),
    });
  }),
);
