import { describe, expect, it } from 'vitest';
import { buildShowcase } from '../src/config/showcase';
import { runPipeline, type PipelineHooks } from '../src/lib/pipeline';
import { SAMPLE_TEXT } from '../src/config/presets';
import { GATE_ORDER } from '../src/lib/gates';
import type { ApiConfig } from '../src/types';

const noopHooks: PipelineHooks = {
  onLog: () => {},
  onAgent: () => {},
  onAgent1: () => {},
  onAgent2: () => {},
  onSegments: () => {},
  onStream: () => {},
  onProgress: () => {},
  onMemory: () => {},
  onEngine: () => {},
};

const noKeyApi: ApiConfig = {
  provider: 'openai',
  baseUrl: 'https://example.invalid/v1',
  model: 'none',
  apiKey: '',
  temperature: 0.8,
  maxTokens: 4096,
  persistKey: false,
};

describe('无模型时的产品行为', () => {
  it('流水线默认拒绝跑仿真（不再偷偷假写）', async () => {
    await expect(
      runPipeline(
        { text: SAMPLE_TEXT, sourceType: 'raw_text' },
        { direction: '绝不原谅', targetTierId: 'standard', api: noKeyApi, reviewWithLLM: false, maxRevision: 0 },
        noopHooks,
      ),
    ).rejects.toThrow(/未配置模型/);
  });

  it('显式允许仿真时仍可运行（仅测试/演示用）', async () => {
    const outcome = await runPipeline(
      { text: SAMPLE_TEXT, sourceType: 'raw_text' },
      {
        direction: '绝不原谅',
        targetTierId: 'standard',
        api: noKeyApi,
        reviewWithLLM: false,
        maxRevision: 0,
        allowSimulation: true,
      },
      noopHooks,
    );
    expect(outcome.segments.length).toBeGreaterThanOrEqual(3);
  });

  it('静态示例的六道门禁结果与真实判定一致', () => {
    const showcase = buildShowcase();
    expect(showcase.segments).toHaveLength(3);
    expect(showcase.segments.every((s) => s.source === 'sample')).toBe(true);
    for (const segment of showcase.segments) {
      expect(segment.gate, '每段都应有门禁结果').toBeTruthy();
      expect(segment.word_count).toBeGreaterThan(300);
      for (const key of GATE_ORDER) {
        expect(segment.gate!.gates[key], `${segment.segment_index} ${key}`).toBe(true);
      }
    }
    expect(showcase.segments[2].gate!.golden_quote_extracted.length).toBeGreaterThan(7);
  });
});
