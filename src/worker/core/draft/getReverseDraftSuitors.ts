import type { DraftPick } from "../../../common/types.ts";

const getReverseDraftSuitors = (
	draftPicks: DraftPick[],
	numSuitors: number,
) => {
	return draftPicks.filter((dp) => dp.round === 1 && dp.pick <= numSuitors);
};

export default getReverseDraftSuitors;
