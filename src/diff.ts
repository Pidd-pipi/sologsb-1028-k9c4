import type { ComponentExample, ComponentSnapshot, ComponentSpec, DiffRow, PropertyChange } from './types';

const selectedFields: Array<Exclude<keyof ComponentSpec, 'snapshots'>> = [
  'name', 'category', 'status', 'purpose', 'usage', 'states', 'keyboardBehavior', 'screenReader', 'disabledScenarios'
];

const format = (value: unknown): string => {
  if (Array.isArray(value)) return value.map((item) => JSON.stringify(item)).join('\n');
  return String(value ?? '');
};

export function diffAgainstSnapshot(component: ComponentSpec, snapshot?: ComponentSnapshot): DiffRow[] {
  if (!snapshot) return [];
  const rows: DiffRow[] = [];
  for (const field of selectedFields) {
    const before = format(snapshot.component[field]);
    const after = format(component[field]);
    if (before !== after) rows.push({ field: String(field), before, after });
  }
  const beforeProperties = format(snapshot.component.properties);
  const afterProperties = format(component.properties);
  if (beforeProperties !== afterProperties) rows.push({ field: 'properties', before: beforeProperties, after: afterProperties });
  const beforeExamples = format(snapshot.component.examples);
  const afterExamples = format(component.examples);
  if (beforeExamples !== afterExamples) rows.push({ field: 'examples', before: beforeExamples, after: afterExamples });
  return rows;
}

const describe = (property: { type: string; required: boolean }) => `类型 ${property.type} · ${property.required ? '必填' : '可选'}`;

export function computePropertyChanges(component: ComponentSpec, snapshot?: ComponentSnapshot): PropertyChange[] {
  if (!snapshot) return [];
  const changes: PropertyChange[] = [];
  const afterById = new Map(component.properties.map((item) => [item.id, item]));
  const beforeIds = new Set(snapshot.component.properties.map((item) => item.id));
  for (const before of snapshot.component.properties) {
    const after = afterById.get(before.id);
    if (!after) {
      changes.push({ key: `removed:${before.id}`, kind: 'removed', breaking: true, beforeId: before.id, afterId: '', beforeName: before.name, afterName: '', detail: describe(before) });
      continue;
    }
    if (after.name !== before.name) {
      changes.push({ key: `renamed:${before.id}`, kind: 'renamed', breaking: true, beforeId: before.id, afterId: after.id, beforeName: before.name, afterName: after.name, detail: `${before.name} → ${after.name}` });
    }
    if (after.type !== before.type) {
      changes.push({ key: `type:${before.id}`, kind: 'type', breaking: true, beforeId: before.id, afterId: after.id, beforeName: before.name, afterName: after.name, detail: `${before.type} → ${after.type}` });
    }
    if (after.required !== before.required) {
      changes.push({ key: `required:${before.id}`, kind: 'required', breaking: after.required, beforeId: before.id, afterId: after.id, beforeName: before.name, afterName: after.name, detail: after.required ? '可选 → 必填' : '必填 → 可选' });
    }
  }
  for (const after of component.properties) {
    if (!beforeIds.has(after.id)) {
      changes.push({ key: `added:${after.id}`, kind: 'added', breaking: after.required, beforeId: '', afterId: after.id, beforeName: '', afterName: after.name, detail: describe(after) });
    }
  }
  return changes;
}

const references = (example: ComponentExample, id: string, name: string): boolean =>
  example.propertyIds.includes(id) || Boolean(name && example.code.includes(name));

export function isExampleAffected(example: ComponentExample, change: PropertyChange): boolean {
  switch (change.kind) {
    case 'added':
      return !references(example, change.afterId, change.afterName);
    case 'required':
      return change.breaking ? !references(example, change.afterId, change.afterName) : false;
    default:
      return references(example, change.beforeId, change.beforeName);
  }
}

export function examplesAffectedBy(component: ComponentSpec, change: PropertyChange): ComponentExample[] {
  return component.examples.filter((example) => isExampleAffected(example, change));
}
