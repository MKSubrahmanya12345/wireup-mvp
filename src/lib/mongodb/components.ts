/**
 * Component catalog repository (MongoDB backed, with an in-process seed cache).
 */

import { getComponentModel, type ComponentDocument } from '@/models/Component';
import type { ComponentDefinition } from '@/types/component';

import { createLogger, describeError } from '@/lib/logging/logger';
import { connectMongo } from '@/lib/mongodb/client';

const logger = createLogger('mongodb:components');

type RawComponent = Partial<ComponentDocument> & { _id?: unknown };

function toDefinition(raw: RawComponent): ComponentDefinition | null {
  if (!raw.id || !raw.name) return null;
  return {
    id: raw.id,
    name: raw.name,
    category: (raw.category ?? 'other') as ComponentDefinition['category'],
    description: raw.description ?? '',
    voltage: typeof raw.voltage === 'number' ? raw.voltage : undefined,
    minVoltage: typeof raw.minVoltage === 'number' ? raw.minVoltage : undefined,
    maxVoltage: typeof raw.maxVoltage === 'number' ? raw.maxVoltage : undefined,
    currentRequirements: raw.currentRequirements,
    pins: Array.isArray(raw.pins) ? raw.pins : [],
    pinTypes: Array.isArray(raw.pinTypes) ? raw.pinTypes : [],
    communicationProtocols: Array.isArray(raw.communicationProtocols) ? raw.communicationProtocols : [],
    powerPins: Array.isArray(raw.powerPins) ? raw.powerPins : [],
    groundPins: Array.isArray(raw.groundPins) ? raw.groundPins : [],
    compatibleMicrocontrollers: raw.compatibleMicrocontrollers,
    incompatibleComponents: raw.incompatibleComponents,
    motorRequirements: raw.motorRequirements,
    powerSourceRequirements: raw.powerSourceRequirements,
    libraryRequirements: raw.libraryRequirements,
    exampleUsage: raw.exampleUsage,
    aliases: Array.isArray(raw.aliases) ? raw.aliases : [],
    keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
    simulator: raw.simulator,
    metadata: (raw.metadata as Record<string, unknown>) ?? {},
    createdAt: raw.createdAt instanceof Date ? raw.createdAt.toISOString() : undefined,
    updatedAt: raw.updatedAt instanceof Date ? raw.updatedAt.toISOString() : undefined,
  };
}

export async function countComponents(): Promise<number> {
  await connectMongo();
  const Component = getComponentModel();
  return Component.countDocuments();
}

export async function listComponents(): Promise<ComponentDefinition[]> {
  await connectMongo();
  const Component = getComponentModel();
  const docs = (await Component.find({}).sort({ category: 1, name: 1 }).lean()) as RawComponent[];
  return docs.map(toDefinition).filter((value): value is ComponentDefinition => value !== null);
}

export async function getComponentById(id: string): Promise<ComponentDefinition | null> {
  await connectMongo();
  const Component = getComponentModel();
  const doc = (await Component.findOne({ id }).lean()) as RawComponent | null;
  return doc ? toDefinition(doc) : null;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  total: number;
}

/** Idempotent upsert keyed on the catalog `id`. */
export async function upsertComponents(definitions: ComponentDefinition[]): Promise<UpsertResult> {
  await connectMongo();
  const Component = getComponentModel();

  let inserted = 0;
  let updated = 0;

  for (const definition of definitions) {
    const payload = { ...definition } as Record<string, unknown>;
    delete payload.createdAt;
    delete payload.updatedAt;
    const result = await Component.updateOne({ id: definition.id }, { $set: payload }, { upsert: true });
    if (result.upsertedCount && result.upsertedCount > 0) inserted += 1;
    else updated += 1;
  }

  const total = await Component.countDocuments();
  logger.info('upserted catalog', { inserted, updated, total });
  return { inserted, updated, total };
}

export async function deleteComponent(id: string): Promise<boolean> {
  await connectMongo();
  const Component = getComponentModel();
  const result = await Component.deleteOne({ id });
  return result.deletedCount === 1;
}

/** Wrap catalog reads so a Mongo outage degrades to the bundled seed. */
export async function tryListComponents(): Promise<{ components: ComponentDefinition[]; source: 'mongodb' | 'error'; error?: string }> {
  try {
    const components = await listComponents();
    return { components, source: 'mongodb' };
  } catch (error) {
    const described = describeError(error);
    logger.warn('catalog read failed, falling back to bundled seed', { error: described.message });
    return { components: [], source: 'error', error: described.message };
  }
}
