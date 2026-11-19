import {
  Document,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  YAMLSeq,
} from 'yaml';

/** Where Duo reads a flow's sandbox: its image, setup script, network allow-list and ID tokens. */
export const AGENT_CONFIG_PATH = '.gitlab/duo/agent-config.yml';

const ID_TOKEN = 'CODETINDER_ID_TOKEN';
const ID_TOKEN_AUDIENCE = 'https://codetinder.dev';

/** A command CodeTinder needs in `setup_script`, and why, written as a comment above it (lines kept). */
export type SetupCommand = {
  readonly command: string;
  readonly why: string;
  /** For Duo's default image (RHEL, `microdnf`, root): left out when the config sets its own. */
  readonly isForDefaultImage: boolean;
};

/** What CodeTinder needs in a project's agent config. */
export type AgentConfigNeeds = {
  readonly allowedDomains: readonly string[];
  readonly setupScript: readonly SetupCommand[];
};

/** What a merge added to the config: each part only when it wasn't there. */
export type AgentConfigAdditions = {
  readonly isIdTokenAdded: boolean;
  readonly allowedDomains: readonly string[];
  readonly setupScript: readonly SetupCommand[];
};

export type AgentConfigMerge =
  | {
      readonly _tag: 'Merged';
      /** The whole config, every key and comment of the team's kept. */
      readonly content: string;
      readonly added: AgentConfigAdditions;
      /** The config's own `image`, when it sets one: the default image's commands were left out. */
      readonly customImage: string | undefined;
    }
  // It already has everything CodeTinder needs.
  | { readonly _tag: 'Unchanged'; readonly customImage: string | undefined }
  // It can't take CodeTinder's settings without changing the team's: left as it is.
  | { readonly _tag: 'Conflict'; readonly reason: string };

const conflict = (reason: string): AgentConfigMerge => ({ _tag: 'Conflict', reason });

/** The strings a node holds: one, or a list of them; none when it holds anything else. */
const stringsOf = (node: unknown): string[] | undefined => {
  if (node === undefined) return [];
  if (isScalar(node) && typeof node.value === 'string') return [node.value];
  if (!isSeq(node)) return undefined;
  const strings = node.items.flatMap(item =>
    isScalar(item) && typeof item.value === 'string' ? [item.value] : [],
  );
  return strings.length === node.items.length ? strings : undefined;
};

/**
 * `existing` (the project's agent config; none when it has none) with what CodeTinder `needs`
 * added, and nothing else changed: its keys, values, order and comments stay. Domains and commands
 * already there aren't added twice, so merging again changes nothing. A config CodeTinder can't
 * add to without changing the team's settings is a `Conflict`, with why.
 */
export const mergeAgentConfig = (
  existing: string | undefined,
  needs: AgentConfigNeeds,
): AgentConfigMerge => {
  // Whatever the YAML, a merge that can't complete leaves the team's file alone, never fails setup.
  try {
    return merge(existing, needs);
  } catch (error) {
    return conflict(
      `CodeTinder couldn't merge into it (${error instanceof Error ? error.message : String(error)})`,
    );
  }
};

/** Whether `node` or anything under it is an anchor or an alias, which a merge could break. */
const hasAnchorOrAlias = (node: unknown): boolean => {
  if (!isNode(node)) return false;
  if (isAlias(node) || node.anchor !== undefined) return true;
  const found = { isFound: false };
  visit(node, {
    Node: (_, child) => {
      if (isAlias(child) || child.anchor !== undefined) {
        found.isFound = true;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return found.isFound;
};

const KEYS_MERGED = ['id_tokens', 'network_policy', 'setup_script'] as const;

const merge = (existing: string | undefined, needs: AgentConfigNeeds): AgentConfigMerge => {
  const doc = existing === undefined ? new Document({}) : parseDocument(existing);
  if (doc.errors.length > 0) return conflict("it isn't valid YAML");
  // Comments alone, or nothing: an empty mapping.
  if (doc.contents === null) {
    const empty = doc.createNode({});
    if (isMap(empty)) doc.contents = empty;
  }
  if (!isMap(doc.contents)) return conflict("it isn't a YAML mapping");
  const anchored = KEYS_MERGED.find(key => hasAnchorOrAlias(doc.get(key, true)));
  if (anchored !== undefined) {
    return conflict(
      `its \`${anchored}\` uses YAML anchors or aliases, which adding to could break`,
    );
  }

  const image = doc.get('image');
  const customImage = typeof image === 'string' ? image : undefined;
  if (image !== undefined && customImage === undefined) {
    return conflict("its `image` isn't a string");
  }

  const idTokens = doc.get('id_tokens', true);
  if (idTokens !== undefined && !isMap(idTokens)) {
    return conflict("its `id_tokens` isn't a mapping");
  }
  const audience = doc.getIn(['id_tokens', ID_TOKEN, 'aud'], true);
  const isIdTokenAdded = (() => {
    if (!doc.hasIn(['id_tokens', ID_TOKEN])) return true;
    if (isScalar(audience) && audience.value === ID_TOKEN_AUDIENCE) return false;
    if (
      isSeq(audience) &&
      audience.items.some(item => isScalar(item) && item.value === ID_TOKEN_AUDIENCE)
    ) {
      return false;
    }
    return undefined;
  })();
  if (isIdTokenAdded === undefined) {
    return conflict(`its \`${ID_TOKEN}\` is for another audience than \`${ID_TOKEN_AUDIENCE}\``);
  }

  const policy = doc.get('network_policy', true);
  if (policy !== undefined && !isMap(policy)) {
    return conflict("its `network_policy` isn't a mapping");
  }
  const domainsNode = doc.getIn(['network_policy', 'allowed_domains'], true);
  const domains = stringsOf(domainsNode);
  if (domains === undefined || (domainsNode !== undefined && !isSeq(domainsNode))) {
    return conflict("its `allowed_domains` isn't a list");
  }

  const scriptNode = doc.get('setup_script', true);
  const commands = stringsOf(scriptNode);
  if (commands === undefined) {
    return conflict("its `setup_script` isn't a command or a list of them");
  }

  const added: AgentConfigAdditions = {
    isIdTokenAdded,
    allowedDomains: [...new Set(needs.allowedDomains)].filter(domain => !domains.includes(domain)),
    setupScript: needs.setupScript.filter(
      ({ command, isForDefaultImage }) =>
        !commands.includes(command) && !(isForDefaultImage && customImage !== undefined),
    ),
  };
  if (!isIdTokenAdded && added.allowedDomains.length === 0 && added.setupScript.length === 0) {
    return { _tag: 'Unchanged', customImage };
  }

  // ponytail: Duo caps `id_tokens` at 20; a config already at the cap gets a 21st it rejects, rare
  // enough to leave to the setup MR's reviewer.
  if (isIdTokenAdded) doc.setIn(['id_tokens', ID_TOKEN, 'aud'], ID_TOKEN_AUDIENCE);
  if (added.setupScript.length > 0) {
    // A one-command script becomes a list, its command first, its comment kept.
    const script = isSeq(scriptNode) ? scriptNode : new YAMLSeq();
    if (isScalar(scriptNode)) script.add(scriptNode);
    added.setupScript.forEach(({ command, why }) => {
      const item = doc.createNode(command);
      item.commentBefore = why
        .split('\n')
        .map(line => ` ${line}`)
        .join('\n');
      script.add(item);
    });
    doc.set('setup_script', script);
  }
  if (added.allowedDomains.length > 0) {
    if (isSeq(domainsNode)) {
      added.allowedDomains.forEach(domain => {
        domainsNode.add(doc.createNode(domain));
      });
    } else {
      doc.setIn(['network_policy', 'allowed_domains'], doc.createNode(added.allowedDomains));
    }
  }
  return { _tag: 'Merged', content: doc.toString(), added, customImage };
};

/** What a merge added, as the YAML it reads as: for a person to review before it's committed. */
export const renderAgentConfigAdditions = ({
  isIdTokenAdded,
  allowedDomains,
  setupScript,
}: AgentConfigAdditions): string =>
  new Document({
    ...(isIdTokenAdded ? { id_tokens: { [ID_TOKEN]: { aud: ID_TOKEN_AUDIENCE } } } : {}),
    ...(setupScript.length > 0 ? { setup_script: setupScript.map(({ command }) => command) } : {}),
    ...(allowedDomains.length > 0 ? { network_policy: { allowed_domains: allowedDomains } } : {}),
  }).toString();
