/// <reference types="vite/client" />

import type { OpenMeetBridge } from '../../shared/ipc';

declare global {
  interface Window {
    openmeet: OpenMeetBridge;
  }
}

export {};
