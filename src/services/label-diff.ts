import type { DecisionSet } from "../classifier/policy";
import { ACTION_KEYS, LABEL_DEFINITIONS } from "../taxonomy/labels";
import type { ActionKey, LabelKey } from "../taxonomy/labels";

export type Dimension = "topic" | ActionKey;

export interface LabelMappingInfo {
  semanticKey: LabelKey;
  canonicalId: string | null;
  aliasIds: string[];
}

export interface DimensionState {
  locked: boolean;
  userControlled: boolean;
}

export interface MessageLabelState {
  currentLabelIds: string[];
  appOwnedLabelIds: string[];
  dimensionStates: Partial<Record<Dimension, DimensionState>>;
}

export interface LabelDiff {
  add: string[];
  remove: string[];
  userControlled: Dimension[];
  preserved: Dimension[];
}

export const equivalenceSet = (mapping: LabelMappingInfo): string[] =>
  [mapping.canonicalId, ...mapping.aliasIds].filter((id): id is string => Boolean(id));

const mappingFor = (
  mappings: LabelMappingInfo[],
  key: LabelKey
): LabelMappingInfo | undefined =>
  mappings.find((mapping) => mapping.semanticKey === key);

const membersPresent = (members: string[], current: string[]): string[] =>
  members.filter((id) => current.includes(id));

const approvedOnly = (ids: string[], approved: Set<string>): string[] =>
  ids.filter((id) => approved.has(id));

export const computeLabelDiff = (input: {
  decisions: DecisionSet;
  mappings: LabelMappingInfo[];
  state: MessageLabelState;
  approvedUserLabelIds: Set<string>;
  unlockedDimensions?: Dimension[];
}): LabelDiff => {
  const { decisions, mappings, state, approvedUserLabelIds } = input;
  const unlocked = new Set(input.unlockedDimensions);
  const add = new Set<string>();
  const remove = new Set<string>();
  const userControlled: Dimension[] = [];
  const preserved: Dimension[] = [];
  const current = state.currentLabelIds;
  const appOwned = new Set(state.appOwnedLabelIds);

  const topicKeys = (Object.keys(LABEL_DEFINITIONS) as LabelKey[]).filter(
    (key) => LABEL_DEFINITIONS[key].kind === "topic"
  );

  const clearMembers = (keys: LabelKey[], overrideOwnership: boolean) => {
    for (const key of keys) {
      const mapping = mappingFor(mappings, key);
      if (!mapping) {
        continue;
      }
      for (const member of membersPresent(equivalenceSet(mapping), current)) {
        if (overrideOwnership || appOwned.has(member)) {
          remove.add(member);
        }
      }
    }
  };

  const preservedByOwner = (dimension: Dimension): boolean => {
    const dimensionState = state.dimensionStates[dimension];
    const locked = dimensionState?.locked && !unlocked.has(dimension);
    if (!(locked || dimensionState?.userControlled)) {
      return false;
    }
    if (dimensionState.userControlled) {
      userControlled.push(dimension);
    }
    preserved.push(dimension);
    return true;
  };

  const applyDimension = (
    dimension: Dimension,
    desiredKey: LabelKey | null,
    decisionStatus: "positive" | "negative" | "uncertain",
    isTopic: boolean
  ) => {
    if (preservedByOwner(dimension)) {
      return;
    }
    if (decisionStatus === "uncertain") {
      preserved.push(dimension);
      return;
    }

    const dimensionKeys: LabelKey[] = isTopic ? topicKeys : [dimension as ActionKey];

    const desiredMapping = desiredKey ? mappingFor(mappings, desiredKey) : undefined;
    const desiredMembers = desiredMapping ? equivalenceSet(desiredMapping) : [];
    const desiredSatisfied = membersPresent(desiredMembers, current).length > 0;

    if (
      decisionStatus === "positive" &&
      desiredKey &&
      desiredMapping &&
      !desiredSatisfied &&
      desiredMapping.canonicalId
    ) {
      add.add(desiredMapping.canonicalId);
    }

    const overrideOwnership = unlocked.has(dimension);
    if (decisionStatus === "negative" || (isTopic && desiredKey === null)) {
      clearMembers(dimensionKeys, overrideOwnership);
    } else if (isTopic && desiredKey) {
      clearMembers(
        dimensionKeys.filter((key) => key !== desiredKey),
        overrideOwnership
      );
    }
  };
  const topicStatus = decisions.topic.status === "accepted" ? "positive" : "uncertain";
  const topicKey = decisions.topic.status === "accepted" ? decisions.topic.key : null;
  applyDimension("topic", topicKey === "other" ? null : topicKey, topicStatus, true);

  for (const key of ACTION_KEYS) {
    const decision = {
      needs_reply: decisions.needsReply,
      to_do: decisions.toDo,
      urgent: decisions.urgent,
    }[key];
    applyDimension(key, key, decision.status, false);
  }

  const addList = approvedOnly([...add], approvedUserLabelIds);
  const removeList = approvedOnly([...remove], approvedUserLabelIds);

  return {
    add: addList.filter((id) => !current.includes(id)),
    preserved,
    remove: removeList,
    userControlled,
  };
};

export const detectManualChanges = (input: {
  currentLabelIds: string[];
  lastObservedLabelIds: string[];
  appOwnedLabelIds: string[];
  mappings: LabelMappingInfo[];
}): Dimension[] => {
  const { currentLabelIds, lastObservedLabelIds, appOwnedLabelIds, mappings } = input;
  const changed = new Set<Dimension>();
  const appOwned = new Set(appOwnedLabelIds);

  const dimensions: { dimension: Dimension; keys: LabelKey[] }[] = [
    {
      dimension: "topic",
      keys: (Object.keys(LABEL_DEFINITIONS) as LabelKey[]).filter(
        (key) => LABEL_DEFINITIONS[key].kind === "topic"
      ),
    },
    ...ACTION_KEYS.map((key) => ({ dimension: key as Dimension, keys: [key] })),
  ];

  for (const { dimension, keys } of dimensions) {
    const members = new Set(
      keys.flatMap((key) => {
        const mapping = mappings.find((candidate) => candidate.semanticKey === key);
        return mapping ? equivalenceSet(mapping) : [];
      })
    );

    for (const id of members) {
      if (
        appOwned.has(id) &&
        lastObservedLabelIds.includes(id) &&
        !currentLabelIds.includes(id)
      ) {
        changed.add(dimension);
      }
      if (
        !appOwned.has(id) &&
        !lastObservedLabelIds.includes(id) &&
        currentLabelIds.includes(id)
      ) {
        changed.add(dimension);
      }
    }
  }

  return [...changed];
};
