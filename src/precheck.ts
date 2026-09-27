import type { ComponentSnapshot, ComponentSpec, PropertySpec } from './types';

/** 单个属性层面的变化类型；同一属性可能同时带有多种变化。 */
export type ChangeKind = 'added' | 'removed' | 'renamed' | 'type-changed' | 'required-tightened' | 'required-relaxed';
export type ChangeBearing = 'compatible' | 'breaking';

export interface PropertyChangeRow {
  /** 快照中的旧属性；新增项为空。 */
  oldId: string;
  /** 草稿中的新属性；移除项为空。 */
  newId: string;
  kinds: ChangeKind[];
  bearing: ChangeBearing;
  detail: string;
}

export interface ImpactedExample {
  id: string;
  title: string;
  /** 该示例引用的破坏项（按旧属性 id）。 */
  referencedBreakers: PropertyChangeRow[];
  /** 引用的破坏项中尚未指定有效替代属性的部分。 */
  uncoveredBreakers: PropertyChangeRow[];
}

export interface PrecheckReport {
  snapshotRevision: number;
  compatible: PropertyChangeRow[];
  breaking: PropertyChangeRow[];
  impacted: ImpactedExample[];
  /** 会被改写的示例：引用的全部破坏项都已覆盖。 */
  toRewrite: ImpactedExample[];
  /** 仍留在待迁移的示例：存在未覆盖的破坏项。 */
  uncoveredExamples: ImpactedExample[];
  /** 引用了某旧属性（propertyIds 或代码文本）的示例数量。 */
  referenceCounts: Record<string, number>;
}

export const CHANGE_LABELS: Record<ChangeKind, string> = {
  added: '新增',
  removed: '移除',
  renamed: '名称变更',
  'type-changed': '类型变化',
  'required-tightened': '必填收紧',
  'required-relaxed': '必填放宽'
};

export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 某个破坏项当前生效的替代属性 id；改名项默认替代为改名后的自身。 */
export function resolveReplacement(row: PropertyChangeRow, plan: Record<string, string> = {}): string {
  const chosen = plan[row.oldId];
  if (chosen !== undefined) return chosen;
  return row.kinds.includes('renamed') ? row.newId : '';
}

interface PropertyDelta {
  oldProperty?: PropertySpec;
  newProperty?: PropertySpec;
  kinds: ChangeKind[];
  notes: string[];
}

/**
 * 以最近快照为对照分析属性变化。同一属性（id 相同）可能同时改名/改类型/改必填，
 * 合并为一行；只要含一种破坏性变化即整体进入破坏栏，兼容变化并入说明。
 */
export function analyzeProperties(component: ComponentSpec, snapshot: ComponentSnapshot): PropertyChangeRow[] {
  const before = new Map(snapshot.component.properties.map((item) => [item.id, item]));
  const after = new Map(component.properties.map((item) => [item.id, item]));
  const rows: PropertyChangeRow[] = [];

  for (const property of component.properties) {
    if (!before.has(property.id)) {
      rows.push({
        oldId: '',
        newId: property.id,
        kinds: ['added'],
        bearing: 'compatible',
        detail: `出现新属性 ${property.name}: ${property.type}${property.required ? '（必填）' : ''}`
      });
    }
  }

  for (const oldProperty of snapshot.component.properties) {
    const newProperty = after.get(oldProperty.id);
    if (!newProperty) {
      rows.push({
        oldId: oldProperty.id,
        newId: '',
        kinds: ['removed'],
        bearing: 'breaking',
        detail: `移除属性 ${oldProperty.name}（原为 ${oldProperty.type}）`
      });
      continue;
    }
    const delta: PropertyDelta = { oldProperty, newProperty, kinds: [], notes: [] };
    if (oldProperty.name !== newProperty.name) {
      delta.kinds.push('renamed');
      delta.notes.push(`名称变更：${oldProperty.name} → ${newProperty.name}`);
    }
    if (oldProperty.type !== newProperty.type) {
      delta.kinds.push('type-changed');
      delta.notes.push(`类型变化：${oldProperty.type} → ${newProperty.type}`);
    }
    if (oldProperty.required !== newProperty.required) {
      if (newProperty.required) {
        delta.kinds.push('required-tightened');
        delta.notes.push('必填变化：由可选变为必填');
      } else {
        delta.kinds.push('required-relaxed');
        delta.notes.push('必填变化：由必填变为可选');
      }
    }
    if (!delta.kinds.length) continue;
    const breakingKinds: ChangeKind[] = ['renamed', 'type-changed', 'required-tightened'];
    const isBreaking = delta.kinds.some((kind) => breakingKinds.includes(kind));
    rows.push({
      oldId: oldProperty.id,
      newId: newProperty.id,
      kinds: delta.kinds,
      bearing: isBreaking ? 'breaking' : 'compatible',
      detail: delta.notes.join('；')
    });
  }

  return rows;
}

function exampleReferences(example: ComponentSpec['examples'][number], oldProperty: PropertySpec): boolean {
  if (example.propertyIds.includes(oldProperty.id)) return true;
  const token = new RegExp(`\\b${escapeRegExp(oldProperty.name)}\\b`);
  return token.test(example.code);
}

export function evaluatePrecheck(component: ComponentSpec): PrecheckReport | null {
  const snapshot = component.snapshots[0];
  if (!snapshot) return null;
  const rows = analyzeProperties(component, snapshot);
  const compatible = rows.filter((row) => row.bearing === 'compatible');
  const breaking = rows.filter((row) => row.bearing === 'breaking');
  const plan = component.migrationPlan ?? {};
  const beforeById = new Map(snapshot.component.properties.map((item) => [item.id, item]));
  const currentIds = new Set(component.properties.map((item) => item.id));

  const referenceCounts: Record<string, number> = {};
  const impacted: ImpactedExample[] = [];
  for (const example of component.examples) {
    const referencedBreakers = breaking.filter((row) => {
      const oldProperty = beforeById.get(row.oldId);
      return oldProperty ? exampleReferences(example, oldProperty) : false;
    });
    if (!referencedBreakers.length) continue;
    for (const breaker of referencedBreakers) referenceCounts[breaker.oldId] = (referenceCounts[breaker.oldId] ?? 0) + 1;
    const uncoveredBreakers = referencedBreakers.filter((row) => {
      const replacement = resolveReplacement(row, plan);
      return !replacement || !currentIds.has(replacement);
    });
    impacted.push({ id: example.id, title: example.title, referencedBreakers, uncoveredBreakers });
  }

  return {
    snapshotRevision: snapshot.revision,
    compatible,
    breaking,
    impacted,
    toRewrite: impacted.filter((item) => item.uncoveredBreakers.length === 0),
    uncoveredExamples: impacted.filter((item) => item.uncoveredBreakers.length > 0),
    referenceCounts
  };
}

/** 有示例仍引用未覆盖的破坏项时，不允许发布。 */
export function hasUncoveredMigrations(component: ComponentSpec): boolean {
  return (evaluatePrecheck(component)?.uncoveredExamples.length ?? 0) > 0;
}

export interface AppliedPrecheck {
  rewrittenExampleIds: string[];
  uncoveredExampleIds: string[];
}

/** 按预检选择改写示例：替换 propertyIds 与代码中的旧属性名，并解除已覆盖示例的失效标记。 */
export function applyPrecheck(component: ComponentSpec): AppliedPrecheck | null {
  const report = evaluatePrecheck(component);
  if (!report) return null;
  const plan = component.migrationPlan ?? {};
  const beforeById = new Map(report ? component.snapshots[0].component.properties.map((item) => [item.id, item]) : []);
  const rewrittenExampleIds: string[] = [];
  const uncoveredExampleIds: string[] = report.uncoveredExamples.map((item) => item.id);
  const removedIds = new Set(report.breaking.filter((row) => row.kinds.includes('removed')).map((row) => row.oldId));

  for (const item of report.toRewrite) {
    const example = component.examples.find((entry) => entry.id === item.id);
    if (!example) continue;
    const replacements = new Map<string, { old: PropertySpec; replacementId: string }>();
    for (const breaker of item.referencedBreakers) {
      const replacementId = resolveReplacement(breaker, plan);
      const oldProperty = beforeById.get(breaker.oldId);
      if (oldProperty && replacementId) replacements.set(breaker.oldId, { old: oldProperty, replacementId });
    }
    const nextIds: string[] = [];
    for (const id of example.propertyIds) {
      const mapped = replacements.get(id);
      if (mapped) {
        if (!nextIds.includes(mapped.replacementId)) nextIds.push(mapped.replacementId);
      } else if (!removedIds.has(id) && !nextIds.includes(id)) {
        nextIds.push(id);
      }
    }
    example.propertyIds = nextIds;
    let code = example.code;
    for (const { old, replacementId } of replacements.values()) {
      const newProperty = component.properties.find((property) => property.id === replacementId);
      if (newProperty && newProperty.name !== old.name) {
        code = code.replace(new RegExp(`\\b${escapeRegExp(old.name)}\\b`, 'g'), newProperty.name);
      }
    }
    example.code = code;
    example.stale = false;
    example.staleReason = '';
    example.createdFromRevision = component.revision;
    rewrittenExampleIds.push(example.id);
  }

  for (const item of report.uncoveredExamples) {
    const example = component.examples.find((entry) => entry.id === item.id);
    if (!example) continue;
    const names = item.uncoveredBreakers
      .map((breaker) => beforeById.get(breaker.oldId)?.name)
      .filter((name): name is string => Boolean(name));
    example.stale = true;
    example.staleReason = `预检未通过：${names.join('、')} 尚未指定替代属性，示例留在待迁移。`;
  }

  if (rewrittenExampleIds.length) component.revision += 1;
  return { rewrittenExampleIds, uncoveredExampleIds };
}
