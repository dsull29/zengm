import { PLAYER } from "../../../common/index.ts";
import type {
	DraftPick,
	MinimalPlayerRatings,
	PlayerWithoutKey,
	ReverseDraftWeights,
} from "../../../common/types.ts";
import { idb } from "../../db/index.ts";
import { g, helpers, random } from "../../util/index.ts";
import { team } from "../index.ts";

type ChoiceCandidate = {
	dp: DraftPick;
	marketScore: number;
	qualityScore: number;
	fitScore: number;
	total: number;
};

const normalize = (num: number, min: number, max: number) => {
	if (max <= min) {
		return 0.5;
	}
	return helpers.bound((num - min) / (max - min), 0, 1);
};

const getAllStarCountAtPos = (
	players: PlayerWithoutKey<MinimalPlayerRatings>[],
	pos: string,
) => {
	let count = 0;
	for (const p of players) {
		if (
			p.tid < 0 ||
			p.tid === PLAYER.UNDRAFTED ||
			p.tid === PLAYER.FREE_AGENT
		) {
			continue;
		}
		const ratings = p.ratings.at(-1);
		if (!ratings || ratings.pos !== pos) {
			continue;
		}
		if (p.awards.some((award) => award.type === "All-Star")) {
			count++;
		}
	}
	return count;
};

const prospectChoosesTeam = async ({
	prospect,
	suitors,
	weights,
}: {
	prospect: PlayerWithoutKey<MinimalPlayerRatings>;
	suitors: DraftPick[];
	weights: ReverseDraftWeights;
}) => {
	const teams = await idb.cache.teams.getAll();
	const teamSeasons = await idb.cache.teamSeasons.indexGetAll(
		"teamSeasonsBySeasonTid",
		[[g.get("season") - 1], [g.get("season") - 1, "Z"]],
	);

	const pos = prospect.ratings.at(-1)?.pos ?? "";

	const teamPlayersByTid = new Map<
		number,
		PlayerWithoutKey<MinimalPlayerRatings>[]
	>();
	for (const suitor of suitors) {
		const players = await idb.cache.players.indexGetAll(
			"playersByTid",
			suitor.tid,
		);
		teamPlayersByTid.set(suitor.tid, players);
	}

	const pops = suitors.map((s) => teams.find((t) => t.tid === s.tid)?.pop ?? 1);
	const popMin = Math.min(...pops);
	const popMax = Math.max(...pops);

	const qualityRawByTid = new Map<number, number>();
	for (const suitor of suitors) {
		const ts = teamSeasons.find((row) => row.tid === suitor.tid);
		const players = teamPlayersByTid.get(suitor.tid) ?? [];
		const teamOvr = team.ovr(
			players.map((p) => ({
				pid: p.pid,
				injury: p.injury,
				value: p.value,
				ratings: {
					ovr: p.ratings.at(-1)?.ovr ?? 0,
					ovrs: p.ratings.at(-1)?.ovrs ?? {},
					pos: p.ratings.at(-1)?.pos ?? "",
				},
			})),
			{
				wholeRoster: true,
			},
		);
		const winp =
			ts !== undefined
				? helpers.calcWinp({
						won: ts.won,
						lost: ts.lost,
						tied: ts.tied,
						otl: ts.otl,
					})
				: 0.5;
		qualityRawByTid.set(
			suitor.tid,
			0.6 * winp + 0.4 * normalize(teamOvr, 0, 100),
		);
	}
	const qualityValues = Array.from(qualityRawByTid.values());
	const qualityMin = Math.min(...qualityValues);
	const qualityMax = Math.max(...qualityValues);

	const fitRawByTid = new Map<number, number>();
	for (const suitor of suitors) {
		const players = teamPlayersByTid.get(suitor.tid) ?? [];
		const samePos = players.filter((p) => p.ratings.at(-1)?.pos === pos);
		const topSamePosOvr = Math.max(
			0,
			...samePos.map((p) => p.ratings.at(-1)?.ovr ?? 0),
		);
		const allStarsSamePos = getAllStarCountAtPos(players, pos);
		const fitRaw =
			1 -
			(0.1 * samePos.length + 0.007 * topSamePosOvr + 0.2 * allStarsSamePos);
		fitRawByTid.set(suitor.tid, fitRaw);
	}
	const fitValues = Array.from(fitRawByTid.values());
	const fitMin = Math.min(...fitValues);
	const fitMax = Math.max(...fitValues);

	const candidates: ChoiceCandidate[] = suitors.map((dp) => {
		const pop = teams.find((t) => t.tid === dp.tid)?.pop ?? 1;
		const marketScore = normalize(pop, popMin, popMax);
		const qualityScore = normalize(
			qualityRawByTid.get(dp.tid) ?? 0.5,
			qualityMin,
			qualityMax,
		);
		const fitScore = normalize(fitRawByTid.get(dp.tid) ?? 0.5, fitMin, fitMax);
		const total =
			weights.market * marketScore +
			weights.quality * qualityScore +
			weights.fit * fitScore +
			random.uniform(0, weights.randomness);

		return {
			dp,
			marketScore,
			qualityScore,
			fitScore,
			total,
		};
	});

	candidates.sort((a, b) => b.total - a.total);
	const winner = candidates[0];
	if (!winner) {
		throw new Error("No suitor candidates");
	}

	const losers = candidates.slice(1, 4);
	const winnerAbbrev = g.get("teamInfoCache")[winner.dp.tid]?.abbrev;
	const loserAbbrevs = losers
		.map((candidate) => g.get("teamInfoCache")[candidate.dp.tid]?.abbrev)
		.filter((abbrev) => abbrev !== undefined);
	const explanation = `chose ${winnerAbbrev}${
		loserAbbrevs.length > 0 ? ` over ${loserAbbrevs.join(", ")}` : ""
	} (market ${winner.marketScore.toFixed(2)}, quality ${winner.qualityScore.toFixed(2)}, fit ${winner.fitScore.toFixed(2)})`;

	return {
		selectedPick: winner.dp,
		explanation,
	};
};

export default prospectChoosesTeam;
