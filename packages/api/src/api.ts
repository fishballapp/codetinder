import * as HttpApi from 'effect/http-api/HttpApi';
import { Authentication } from './authentication';
import { ClaimsApi } from './claims';
import { ProjectsApi } from './projects';
import { RoundsApi } from './rounds';
import { SweepsApi } from './sweeps';

export class Api extends HttpApi.make('codetinder')
  .add(RoundsApi)
  .add(ProjectsApi)
  .add(ClaimsApi)
  .add(SweepsApi)
  .middleware(Authentication) {}
