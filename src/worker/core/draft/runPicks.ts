import { DRAFT_BY_TEAM_OVR, PHASE, PLAYER } from "../../../common/index.ts";
import afterPicks from "./afterPicks.ts";
import getReverseDraftSuitors from "./getReverseDraftSuitors.ts";
import getOrder from "./getOrder.ts";
import prospectChoosesTeam from "./prospectChoosesTeam.ts";
import selectPlayer from "./selectPlayer.ts";
import { idb } from "../../db/index.ts";
import { g, local, lock, random } from "../../util/index.ts";
import type {
	Conditions,
	MinimalPlayerRatings,
	Player,
	PlayerWithoutKey,
} from "../../../common/types.ts";
import { player, team } from "../index.ts";

export const getTeamOvrDiffs = (
	teamPlayers: PlayerWithoutKey<MinimalPlayerRatings>[],
	players: PlayerWithoutKey<MinimalPlayerRatings>[],
	options?: {
		force?: boolean;
	},
) => {
	if (!DRAFT_BY_TEAM_OVR && !options?.force) {
		return [];
	}

	const teamPlayers2 = teamPlayers.map((p) => ({
		pid: p.pid,
		injury: p.injury,
		value: p.value,
		ratings: {
			ovr: player.fuzzRating(p.ratings.at(-1)!.ovr, p.ratings.at(-1)!.fuzz),
			ovrs: player.fuzzOvrs(p.ratings.at(-1)!.ovrs, p.ratings.at(-1)!.fuzz),
			pos: p.ratings.at(-1)!.pos,
		},
	}));

	const baseline = team.ovr(teamPlayers2, {
		wholeRoster: true,
	});

	return players.map((p) => {
		const ratings = p.ratings.at(-1)!;
		const newOvr = team.ovr(
			[
				...teamPlayers2,
				{
					pid: p.pid,
					injury: p.injury,
					value: p.value,
					ratings: {
						ovr: player.fuzzRating(ratings.ovr, ratings.fuzz),
						ovrs: player.fuzzOvrs(ratings.ovrs, ratings.fuzz),
						pos: ratings.pos,
					},
				},
			],
			{
				wholeRoster: true,
			},
		);

		return newOvr - baseline;
	});
};

const getDraftScore = (
	p: Player<MinimalPlayerRatings>,
	i: number,
	teamOvrDiffs: number[],
) => {
	if (DRAFT_BY_TEAM_OVR) {
		return (teamOvrDiffs[i]! + 0.05 * p.value) ** 40;
	}

	return p.value ** 69;
};

const getRankChoiceVoteScore = (
	p: Player<MinimalPlayerRatings>,
	i: number,
	teamOvrDiffs: number[],
	teamPosStats: Map<
		string,
		{
			count: number;
			maxOvr: number;
			allStars: number;
		}
	>,
) => {
	const pos = p.ratings.at(-1)?.pos ?? "";
	const posStats = teamPosStats.get(pos) ?? {
		count: 0,
		maxOvr: 0,
		allStars: 0,
	};
	const fitPenalty =
		7 * posStats.count + 0.12 * posStats.maxOvr + 9 * posStats.allStars;
	return p.value + 4 * teamOvrDiffs[i]! - fitPenalty;
};

export const getReverseDraftSuitorsWhoRankProspect = async ({
	prospect,
	playersAll,
	suitors,
	numRankedProspects,
}: {
	prospect: Player<MinimalPlayerRatings>;
	playersAll: Player<MinimalPlayerRatings>[];
	suitors: Awaited<ReturnType<typeof getReverseDraftSuitors>>;
	numRankedProspects: number;
}) => {
	const prospectIndex = playersAll.findIndex((p) => p.pid === prospect.pid);
	if (prospectIndex < 0) {
		return [];
	}

	const screenedSuitors = [];
	for (const suitor of suitors) {
		const teamPlayers = await idb.cache.players.indexGetAll(
			"playersByTid",
			suitor.tid,
		);
		const teamOvrDiffs = await getTeamOvrDiffs(teamPlayers, playersAll, {
			force: true,
		});
		const teamPosStats = new Map<
			string,
			{
				count: number;
				maxOvr: number;
				allStars: number;
			}
		>();
		for (const p of teamPlayers) {
			const pos = p.ratings.at(-1)?.pos;
			if (!pos) {
				continue;
			}
			const stats = teamPosStats.get(pos) ?? {
				count: 0,
				maxOvr: 0,
				allStars: 0,
			};
			stats.count += 1;
			stats.maxOvr = Math.max(stats.maxOvr, p.ratings.at(-1)?.ovr ?? 0);
			if (p.awards.some((award) => award.type === "All-Star")) {
				stats.allStars += 1;
			}
			teamPosStats.set(pos, stats);
		}
		const prospectScore = getRankChoiceVoteScore(
			playersAll[prospectIndex]!,
			prospectIndex,
			teamOvrDiffs,
			teamPosStats,
		);
		let numRankedAhead = 0;
		for (const [i, p] of playersAll.entries()) {
			if (
				getRankChoiceVoteScore(p, i, teamOvrDiffs, teamPosStats) > prospectScore
			) {
				numRankedAhead += 1;
				if (numRankedAhead >= numRankedProspects) {
					break;
				}
			}
		}
		if (numRankedAhead < numRankedProspects) {
			screenedSuitors.push(suitor);
		}
	}

	return screenedSuitors;
};

/**
 * Simulate draft picks until it's the user's turn or the draft is over.
 *
 * This could be made faster by passing a transaction around, so all the writes for all the picks are done in one transaction. But when calling selectPlayer elsewhere (i.e. in testing or in response to the user's pick), it needs to be sure that the transaction is complete before continuing. So I would need to create a special case there to account for it. Given that this isn't really *that* slow now, that probably isn't worth the complexity. Although... team.rosterAutoSort does precisely this... so maybe it would be a good idea...
 *
 * @memberOf core.draft
 * @param {boolean} onlyOne If true, only do one pick. If false, do all picks until the user's next pick. Default false.
 * @return {Promise.[Array.<Object>, Array.<number>]} Resolves to an array of player IDs who were drafted during this function call, in order.
 */
const runPicks = async (
	action:
		| {
				type: "onePick" | "untilYourNextPick" | "untilEnd";
		  }
		| {
				type: "untilPick";
				dpid: number;
		  },
	conditions?: Conditions,
) => {
	if (lock.get("drafting")) {
		return [];
	}

	await lock.set("drafting", true);
	const pids: number[] = [];
	let draftPicks = await getOrder();

	const expansionDraft = g.get("expansionDraft");

	let playersAll: Player<MinimalPlayerRatings>[];
	if (g.get("phase") === PHASE.FANTASY_DRAFT) {
		playersAll = await idb.cache.players.indexGetAll(
			"playersByTid",
			PLAYER.UNDRAFTED,
		);
	} else if (expansionDraft.phase === "draft") {
		playersAll = (
			await idb.cache.players.indexGetAll("playersByTid", [0, Infinity])
		).filter((p) => expansionDraft.availablePids.includes(p.pid));
	} else {
		playersAll = (
			await idb.cache.players.indexGetAll("playersByDraftYearRetiredYear", [
				[g.get("season")],
				[g.get("season"), Infinity],
			])
		).filter((p) => p.tid === PLAYER.UNDRAFTED);
	}
	playersAll.sort((a, b) => b.value - a.value);

	// Called after either the draft is over or it's the user's pick
	const afterDoneAuto = async () => {
		await lock.set("drafting", false);

		// Is draft over?
		await afterPicks(draftPicks.length === 0, conditions);
		return pids;
	};

	// This will actually draft "untilUserOrEnd"
	const autoSelectPlayer = async (): Promise<number[]> => {
		if (draftPicks[0]) {
			const expansionDraft2 = g.get("expansionDraft"); // Get again, might have changed
			if (
				expansionDraft2.phase === "draft" &&
				expansionDraft2.numPerTeam !== undefined
			) {
				// Keep logic in sync with draft.ts
				const tidsOverLimit: number[] = [];
				for (const [tidString, numPerTeam] of Object.entries(
					expansionDraft2.numPerTeamDrafted,
				)) {
					if (numPerTeam >= expansionDraft2.numPerTeam) {
						const tid = Number.parseInt(tidString);
						tidsOverLimit.push(tid);
					}
				}
				if (tidsOverLimit.length > 0) {
					playersAll = playersAll.filter((p) => !tidsOverLimit.includes(p.tid));
				}
			}

			// If there are no players, delete the rest of the picks and draft is done
			if (playersAll.length === 0) {
				for (const dp of draftPicks) {
					await idb.cache.draftPicks.delete(dp.dpid);
				}
				draftPicks = await getOrder();
				return afterDoneAuto();
			}

			const dp = draftPicks[0];

			const singleUserPickInSpectatorMode =
				g.get("spectator") && action.type === "onePick";
			const pauseForUserPick =
				g.get("userTids").includes(dp.tid) &&
				!local.autoPlayUntil &&
				!singleUserPickInSpectatorMode &&
				action.type !== "untilEnd" &&
				action.type !== "untilPick";

			const pauseForDpid =
				action.type === "untilPick" && dp.dpid === action.dpid;

			if (pauseForUserPick || pauseForDpid) {
				return afterDoneAuto();
			}

			const firstRoundPicksRemaining = draftPicks.filter(
				(p) => p.round === 1,
			).length;
			const firstRoundPicksMade =
				g.get("numActiveTeams") - firstRoundPicksRemaining;
			const reverseDraftEnabled =
				g.get("phase") === PHASE.DRAFT &&
				g.get("reverseDraft") &&
				dp.round === 1 &&
				firstRoundPicksMade < g.get("reverseDraftNumProspects");

			let selectedDp = dp;
			let selection: Player<MinimalPlayerRatings>;
			let reverseDraftExplanation: string | undefined;
			if (reverseDraftEnabled) {
				const suitors = getReverseDraftSuitors(
					draftPicks,
					g.get("reverseDraftNumSuitors"),
				);
				const prospect = playersAll[0];
				if (!prospect) {
					throw new Error("No top prospect available");
				}
				if (suitors.length > 0) {
					const screenedSuitors = await getReverseDraftSuitorsWhoRankProspect({
						prospect,
						playersAll,
						suitors,
						numRankedProspects: g.get("reverseDraftNumProspects"),
					});
					if (screenedSuitors.length > 0) {
						const reverseResult = await prospectChoosesTeam({
							prospect,
							suitors: screenedSuitors,
							weights: g.get("reverseDraftWeights"),
						});
						selectedDp = reverseResult.selectedPick;
						selection = prospect;
						reverseDraftExplanation = reverseResult.explanation;
					} else {
						const teamPlayers = await idb.cache.players.indexGetAll(
							"playersByTid",
							dp.tid,
						);
						const teamOvrDiffs = await getTeamOvrDiffs(teamPlayers, playersAll);
						selection = random.choice(playersAll, (p, i) =>
							getDraftScore(p, i, teamOvrDiffs),
						);
					}
				} else {
					selection = playersAll[0]!;
				}
			} else {
				const teamPlayers = await idb.cache.players.indexGetAll(
					"playersByTid",
					dp.tid,
				);
				const teamOvrDiffs = await getTeamOvrDiffs(teamPlayers, playersAll);

				selection = random.choice(playersAll, (p, i) =>
					getDraftScore(p, i, teamOvrDiffs),
				);
			}

			// selectedDp may differ from draftPicks[0] in reverse draft mode
			draftPicks = draftPicks.filter((p) => p.dpid !== selectedDp.dpid);

			const pid = selection.pid;
			await selectPlayer(selectedDp, pid, {
				reverseDraftExplanation,
			});
			pids.push(pid);
			playersAll = playersAll.filter((p) => p !== selection); // Delete from the list of undrafted players

			if (action.type !== "onePick") {
				return autoSelectPlayer();
			}
		}

		return afterDoneAuto();
	};

	return autoSelectPlayer();
};

export default runPicks;
