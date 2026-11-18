import * as Domain from "@alchemy.run/domain";
import * as Aggregate from "@alchemy.run/domain/Aggregate";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export class Closed extends Domain.Event("Closed", { by: Schema.String }) {}

export class AlreadyClosed extends Domain.Rejection("AlreadyClosed", { by: Schema.String }) {}

export class NotApproved extends Domain.Rejection("NotApproved", {}) {}

export class Close extends Domain.Command("Close", {
	target: Schema.String,
	input: { by: Schema.String, approved: Schema.Boolean },
	events: [Closed],
	rejects: [AlreadyClosed, NotApproved],
}) {}

const IssueState = Schema.Struct({
	open: Schema.Boolean,
	closedBy: Schema.String,
});

type IssueState = typeof IssueState.Type;

export const OPEN: IssueState = { open: true, closedBy: "" };

export class Issue extends Domain.Aggregate("Issue", {
	id: Schema.String,
	state: IssueState,
	initial: OPEN,
	commands: [Close],
	decide: {
		Close: (issue, close) => {
			if (!issue.open) {
				return new AlreadyClosed({ by: issue.closedBy });
			}
			if (!close.approved) {
				return new NotApproved({});
			}
			return [new Closed({ by: close.by })];
		},
	},
	evolve: {
		Closed: (_issue, closed) => ({ open: false, closedBy: closed.by }),
	},
}) {}

export type Verdict =
	| { readonly accepted: true; readonly state: IssueState }
	| { readonly accepted: false; readonly rejection: string; readonly detail: Readonly<Record<string, unknown>> };

const detailOf = (rejection: { readonly _tag: string }): Record<string, unknown> =>
	Object.fromEntries(Object.entries(rejection).filter(([key]) => key !== "_tag"));

export const decideClose = (id: string, state: IssueState, by: string, approved: boolean): Verdict => {
	const prediction = Aggregate.predict(Issue, state, new Close({ by, approved }), { id, now: DateTime.makeUnsafe(0) });
	switch (prediction._tag) {
		case "Accepted":
			return { accepted: true, state: Schema.decodeUnknownSync(IssueState)(prediction.state) };
		case "Rejected":
			return { accepted: false, rejection: prediction.rejection._tag, detail: detailOf(prediction.rejection) };
		case "Unpredictable":
			throw new Error(`issue ${id} could not decide Close`);
	}
};
