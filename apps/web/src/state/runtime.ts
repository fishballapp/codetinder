import {
  GitLabCatalog,
  GitLabDiscussions,
  GitLabFiles,
  GitLabMergeRequestLinks,
  GitLabOAuth,
  GitLabProjects,
  GitLabRemoval,
  GitLabSetup,
  GitLabSweepPage,
} from '@codetinder/gitlab';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Atom from 'effect/reactivity/Atom';
import { Session } from '../auth/auth';

const servicesLayer = Layer.mergeAll(
  GitLabOAuth.layer,
  GitLabProjects.layer,
  GitLabDiscussions.layer,
  GitLabFiles.layer,
  GitLabMergeRequestLinks.layer,
  GitLabCatalog.layer,
  GitLabSetup.layer,
  GitLabRemoval.layer,
  GitLabSweepPage.layer,
).pipe(Layer.provideMerge(FetchHttpClient.layer));

export const webLayer = Session.layer.pipe(Layer.provideMerge(servicesLayer));

export const webRuntime = Atom.runtime(webLayer);
