const closed = [];
const refused = [];
const skipped = [];
for (const issue of tool("list_issues", {})) {
  const answer = tool("ask_human", { id: issue.id, question: "Close issue #" + issue.id + " " + issue.title + "?" });
  if (answer.approve !== true) {
    skipped.push(issue.id);
    continue;
  }
  const result = tool("close_issue", { id: issue.id });
  if (result.closed === true) closed.push(issue.id);
}
({ closed, refused, skipped })
