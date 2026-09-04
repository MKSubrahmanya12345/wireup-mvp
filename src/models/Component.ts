/**
 * MongoDB model for the component catalog.
 *
 * Deep engineering structures are stored as Mixed so the document is a faithful
 * JSON copy of `ComponentDefinition` — no `_id` pollution, no lossy casting.
 */

import mongoose, { type Model, type Types } from 'mongoose';

import type { ComponentDefinition } from '@/types/component';

export interface ComponentDocument extends ComponentDefinition {
  _id: Types.ObjectId;
}

const ComponentSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    category: { type: String, required: true, index: true },
    description: { type: String, required: true },
    voltage: { type: mongoose.Schema.Types.Mixed },
    minVoltage: { type: mongoose.Schema.Types.Mixed },
    maxVoltage: { type: mongoose.Schema.Types.Mixed },
    currentRequirements: { type: mongoose.Schema.Types.Mixed },
    pins: { type: mongoose.Schema.Types.Mixed, default: [] },
    pinTypes: { type: mongoose.Schema.Types.Mixed, default: [] },
    communicationProtocols: { type: mongoose.Schema.Types.Mixed, default: [] },
    powerPins: { type: mongoose.Schema.Types.Mixed, default: [] },
    groundPins: { type: mongoose.Schema.Types.Mixed, default: [] },
    compatibleMicrocontrollers: { type: mongoose.Schema.Types.Mixed },
    incompatibleComponents: { type: mongoose.Schema.Types.Mixed },
    motorRequirements: { type: mongoose.Schema.Types.Mixed },
    powerSourceRequirements: { type: mongoose.Schema.Types.Mixed },
    libraryRequirements: { type: mongoose.Schema.Types.Mixed },
    exampleUsage: { type: mongoose.Schema.Types.Mixed },
    aliases: { type: mongoose.Schema.Types.Mixed, default: [] },
    keywords: { type: mongoose.Schema.Types.Mixed, default: [] },
    simulator: { type: mongoose.Schema.Types.Mixed },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    versionKey: false,
    collection: 'components',
  },
);

ComponentSchema.index({ category: 1, name: 1 });
ComponentSchema.index({ keywords: 1 });

export function getComponentModel(): Model<ComponentDocument> {
  return (mongoose.models.Component as Model<ComponentDocument>) || mongoose.model<ComponentDocument>('Component', ComponentSchema);
}

export default getComponentModel;
