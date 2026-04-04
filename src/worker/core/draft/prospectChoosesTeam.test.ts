import { afterAll, assert, beforeAll, test } from "vitest";
import { mockIDBLeague } from "../../../test/helpers.ts";
import { idb } from "../../db/index.ts";
import { g } from "../../util/index.ts";
import { draft } from "../index.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { PLAYER } from "../../../common/index.ts";
import { loadTeamSeasons } from "./testHelpers.ts";
import getReverseDraftSuitors from "./getReverseDraftSuitors.ts";
import prospectChoosesTeam from "./prospectChoosesTeam.ts";

beforeAll(async () => {
	await loadTeamSeasons();
	idb.league = mockIDBLeague();
	await draft.genPlayers(g.get("season"), DEFAULT_LEVEL);
	await draft.genOrder();
});

afterAll(() => {
	// @ts-expect-error
	idb.league = undefined;
});

test("returns only round-1 suitor picks", async () => {
	const draftPicks = await draft.getOrder();
	const suitors = getReverseDraftSuitors(draftPicks, 10);
	assert.ok(suitors.length > 0);
	assert.ok(suitors.every((dp) => dp.round === 1 && dp.pick <= 10));
});

test("selects one of the suitor picks and provides explanation", async () => {
	const draftPicks = await draft.getOrder();
	const suitors = getReverseDraftSuitors(draftPicks, 8);
	const players = (
		await idb.cache.players.indexGetAll("playersByDraftYearRetiredYear", [
			[g.get("season")],
			[g.get("season"), Infinity],
		])
	).filter((p) => p.tid === PLAYER.UNDRAFTED);
	players.sort((a, b) => b.value - a.value);
	const prospect = players[0];
	assert.ok(prospect);

	const result = await prospectChoosesTeam({
		prospect: prospect!,
		suitors,
		weights: {
			market: 0.35,
			quality: 0.35,
			fit: 0.3,
			randomness: 0,
		},
	});

	assert.ok(suitors.some((dp) => dp.dpid === result.selectedPick.dpid));
	assert.ok(result.explanation.length > 0);
});
