/**
 * The merge request description for removing CodeTinder from a project: what was turned off, and
 * what the developer keeps to delete if they want.
 */
export const removalMergeRequestDescription = (): string =>
  `💔 **Breaking up is hard to do.**

Merging this merge request removes CodeTinder from this project. Here is what was done, and what is left for you:

- **Turned off:** the \`codetinder\` flow, with its triggers and its service account. No new merge request gets a round.
- **Closed:** the "Add CodeTinder 💘" setup merge request, if it was still open.
- **Removed by this merge request:** \`.codetinder/config.json\`.

Kept, and yours to delete if you want:

- \`.codetinder/principles.md\`: the coding taste CodeTinder learned from your swipes. Your agents may still follow it, so keep it while they do.
- The "Coding principles" section setup added to your agent instructions (\`AGENTS.md\` and the like), between \`<!-- codetinder:principles -->\` markers: it points your agents at the principles doc, so remove it with the doc.
- \`.gitlab/duo/agent-config.yml\`: the \`codetinder.dev\` host and the \`CODETINDER_ID_TOKEN\` it declared. The file may hold other flows' settings too, so remove only those.

Your rounds on codetinder.dev stay there.
`;
