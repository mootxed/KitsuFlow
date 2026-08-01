// @vitest-environment node
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { DeviceFlowController, type DeviceFlowState } from '../../src/github/device-flow';
import { server } from '../test-server';

describe('GitHub Device Flow', () => {
  it('polls pending authorization and respects slow_down', async () => {
    let polls = 0;
    server.use(
      http.post('https://github.com/login/device/code', () =>
        HttpResponse.json({
          device_code: 'device',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 120,
          interval: 1,
        }),
      ),
      http.post('https://github.com/login/oauth/access_token', () => {
        polls += 1;
        if (polls === 1) return HttpResponse.json({ error: 'authorization_pending' });
        if (polls === 2) return HttpResponse.json({ error: 'slow_down' });
        return HttpResponse.json({ access_token: 'token' });
      }),
    );
    const states: DeviceFlowState[] = [];
    const delays: number[] = [];
    const result = new DeviceFlowController('test-client-id', async (milliseconds) => {
      delays.push(milliseconds);
    }).start((state) => states.push(state));
    const token = await result;
    expect(token, JSON.stringify(states)).toBe('token');
    expect(states.some((state) => state.phase === 'waiting')).toBe(true);
    expect(polls).toBe(3);
    expect(delays).toEqual([1_000, 1_000, 6_000]);
  });
});
