import { fc } from "@fast-check/vitest";

const numRuns = process.env.FC_NUM_RUNS ? Number(process.env.FC_NUM_RUNS) : 100;
fc.configureGlobal({ numRuns });
