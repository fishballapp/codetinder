import { Api } from '@codetinder/api';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Layer from 'effect/Layer';
import { AuthenticationLive, CachedGitLabUsers } from './authentication';
import { ClaimsApiLive } from './claims-api';
import { ProjectsApiLive } from './projects-api';
import { RequestBodyLimit } from './request-body-limit';
import { RoundQrRoute } from './round-qr';
import { RoundsApiLive } from './rounds-api';
import { StaticRoutes } from './static-routes';
import { SweepsApiLive } from './sweeps-api';

/** HttpApi routes, static pages and rounds' QR codes. Callers provide the stores and GitLab layers. */
export const ApiRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(RoundsApiLive),
  Layer.provide(ProjectsApiLive),
  Layer.provide(ClaimsApiLive),
  Layer.provide(SweepsApiLive),
  Layer.provideMerge(AuthenticationLive),
  Layer.provide(CachedGitLabUsers.layer),
  Layer.provide(RequestBodyLimit.layer),
);

export const AppRoutes = Layer.mergeAll(ApiRoutes, StaticRoutes, RoundQrRoute);
