/**
 * /project/[id]/simulation — the emulator and the generated dashboard, with
 * one toggle between them and a live serial relay running between the two.
 */

import { SimulationPanel } from '@/components/workspace/panels/SimulationPanel';

export default function SimulationPage() {
  return <SimulationPanel />;
}
