import type { GitLabProjectSetup } from '@codetinder/gitlab';

/** Where CodeTinder stands in one project, from what GitLab says about it. */
export type ProjectState =
  | { readonly _tag: 'NotAdded' }
  /** The flow is on and the setup MR merged: CodeTinder starts rounds the ways its trigger says. */
  | {
      readonly _tag: 'Live';
      readonly consumerId: string;
      readonly version: string | null;
      /** The catalog's latest version, when the project is pinned to an older one. */
      readonly updateTo: string | null;
    }
  /** The flow is on; the setup MR waits to be merged. */
  | { readonly _tag: 'SetupOpen'; readonly setupMergeRequestUrl: string }
  /** The flow is off and the removal MR waits to be merged: the config goes with it. */
  | {
      readonly _tag: 'Removing';
      readonly removalMergeRequest: { readonly iid: string; readonly url: string };
    }
  /** Half added (a failed add, a closed setup MR, a flow turned off): what is still missing. */
  | {
      readonly _tag: 'Unfinished';
      readonly needsFlow: boolean;
      readonly needsSetupMergeRequest: boolean;
      /** The setup MR waiting to be merged while the flow is off, if any. */
      readonly setupMergeRequestUrl: string | null;
    };

export const projectState = (
  { consumer, setupMergeRequestUrl, removalMergeRequest, hasConfig }: GitLabProjectSetup,
  latestVersion: string,
): ProjectState => {
  if (
    consumer === null &&
    setupMergeRequestUrl === null &&
    !hasConfig &&
    removalMergeRequest === null
  ) {
    return { _tag: 'NotAdded' };
  }
  // A setup MR still open means the cleanup isn't done: the project stays removable.
  if (consumer === null && removalMergeRequest !== null && setupMergeRequestUrl === null) {
    return { _tag: 'Removing', removalMergeRequest };
  }
  if (consumer !== null && hasConfig) {
    const version = consumer.pinnedVersion;
    return {
      _tag: 'Live',
      consumerId: consumer.id,
      version,
      updateTo: version !== null && version !== latestVersion ? latestVersion : null,
    };
  }
  if (consumer !== null && setupMergeRequestUrl !== null) {
    return { _tag: 'SetupOpen', setupMergeRequestUrl };
  }
  return {
    _tag: 'Unfinished',
    needsFlow: consumer === null,
    needsSetupMergeRequest: !hasConfig && setupMergeRequestUrl === null,
    setupMergeRequestUrl,
  };
};
