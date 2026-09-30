import type {JsonObject} from "./domain-types";

export function sanitizeWorkout(value:unknown,now?:number):JsonObject;
export function summarizeWorkout(workout:Record<string,any>):{
  id:string;
  title:string;
  planDay:string;
  date:string;
  status:string;
  startedAt:number;
  completedAt:number|null;
  elapsedSeconds:number;
  adjustment?:"recovery";
  totalSets:number;
  completedSets:number;
  exerciseCount:number;
  exerciseSummaries:Array<{
    exerciseId:string;
    measurement:"reps"|"timed";
    loadType:"external"|"bodyweight"|"assisted";
    unit:"kg"|"lb";
    completedSets:number;
    totalReps:number;
    maxReps:number|null;
    maxWeight:number|null;
    minAssistance:number|null;
    volume:number;
    totalSeconds:number;
    maxSeconds:number|null;
    setValues:Array<{
      reps:number|null;
      weight:number|null;
      seconds:number|null;
      effort:number|null;
      effortType:"none"|"rir"|"rpe";
    }>;
  }>;
};
export function workoutPayload(row:Record<string,any>|null|undefined,summary?:boolean,includeMemory?:boolean):Record<string,any>|null;
