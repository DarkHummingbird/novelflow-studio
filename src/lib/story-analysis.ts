export interface StoryCharacter {
  name: string;
  role: string;
  state: string;
}

export interface StoryAnalysis {
  mainPlot: string;
  characters: StoryCharacter[];
  conflict: string;
  currentScene: string;
  pointOfView: string;
  style: string;
  openThreads: string[];
  openingBeat: string;
  partPlan: string[];
}
