import { FrontEnd, Setup } from '../src/core/parts';
import { FrontAssembly, assembleFront } from '../src/core/trim';
import { FrontState, MotionInputs, solveFrontState } from '../src/core/metrics';
import { defaultState } from '../src/state/setup';

export interface Rig {
  front: FrontEnd;
  setup: Setup;
  fa: FrontAssembly;
  solve(inp?: Partial<MotionInputs>): FrontState;
}

export function rig(mutate?: (front: FrontEnd, setup: Setup) => void): Rig {
  const { front, setup } = defaultState();
  if (mutate) mutate(front, setup);
  const fa = assembleFront(front, setup);
  return {
    front, setup, fa,
    solve(inp?: Partial<MotionInputs>): FrontState {
      return solveFrontState(fa, front.chassis.wheelbase, {
        travL: 0, travR: 0, steerDeg: 0, mode: 'wheel', ...inp,
      });
    },
  };
}
