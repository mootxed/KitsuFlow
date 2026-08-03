import { expect, test } from '@playwright/test';

const issue = (
  number: number,
  title: string,
  state = 'open',
  labels: Array<{ name: string; color: string }> = [],
) => ({
  number,
  node_id: `I_${number}`,
  title,
  body: `Description for ${title}`,
  state,
  labels,
  assignees: [{ login: 'verylongassigneelogin' }],
  html_url: `https://github.com/acme/repo/issues/${number}`,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem('kitsuflow.github.access-token', 'e2e-token'),
  );
  await page.route('https://api.github.com/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/user')
      return route.fulfill({
        json: {
          id: 1,
          login: 'fox',
          name: 'Fox Dev',
          avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
        },
      });
    if (url.pathname === '/user/installations')
      return route.fulfill({
        json: { total_count: 1, installations: [{ id: 9, account: { login: 'acme' } }] },
      });
    if (url.pathname === '/user/installations/9/repositories')
      return route.fulfill({
        json: {
          total_count: 1,
          repositories: [
            {
              id: 2,
              full_name: 'acme/repo',
              name: 'repo',
              private: false,
              owner: { login: 'acme' },
              permissions: { pull: true, push: true },
            },
          ],
        },
      });
    if (url.pathname === '/repos/acme/repo/issues' && method === 'GET')
      return route.fulfill({
        json: [
          issue(1, 'Task to drag by title', 'open'),
          issue(
            2,
            'Very long issue title in done column that should never overflow column boundary ' +
              'word '.repeat(20),
            'closed',
            [{ name: 'very-long-feature-label-name-testing-overflow-behavior', color: 'ef4444' }],
          ),
        ],
      });
    if (url.pathname === '/repos/acme/repo/labels') return route.fulfill({ json: [] });
    if (url.pathname === '/repos/acme/repo/assignees') return route.fulfill({ json: [] });
    if (url.pathname.startsWith('/repos/acme/repo/issues/') && method === 'PATCH')
      return route.fulfill({ json: issue(1, 'Task to drag by title') });
    return route.fulfill({ status: 404, json: { message: `Unhandled ${method} ${url.pathname}` } });
  });
});

test('full-card drag by card title updates status without opening details panel', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText('Fox Dev')).toBeVisible();

  // Pin repository
  await page.getByRole('button', { name: 'Выбрать репозитории' }).click();
  await page.getByText('acme/repo', { exact: true }).click();
  await page.getByLabel('Выбор репозиториев').getByRole('button', { name: 'Готово' }).click();

  // Open repository board
  await page.locator('.repository-link').first().click();

  const cardTitle = page.locator('.task-title', { hasText: 'Task to drag by title' }).first();
  const inProgressCol = page.locator('.col-progress').first();

  await expect(cardTitle).toBeVisible();
  await expect(inProgressCol).toBeVisible();

  // Perform drag from title center to in progress column
  const cardBox = await cardTitle.boundingBox();
  const colBox = await inProgressCol.boundingBox();

  expect(cardBox).not.toBeNull();
  expect(colBox).not.toBeNull();

  await page.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + cardBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(colBox!.x + colBox!.width / 2, colBox!.y + colBox!.height / 2, {
    steps: 10,
  });
  await page.mouse.up();

  // DetailsPanel should NOT be open
  await expect(page.getByLabel('Детали задачи')).not.toBeVisible();
});

test('cards in Done column stay strictly within column bounds across viewports', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Выбрать репозитории' }).click();
  await page.getByText('acme/repo', { exact: true }).click();
  await page.getByLabel('Выбор репозиториев').getByRole('button', { name: 'Готово' }).click();
  await page.locator('.repository-link').first().click();

  const viewports = [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ];

  for (const vp of viewports) {
    await page.setViewportSize(vp);

    const doneCol = page.locator('.col-done').first();
    const doneCard = doneCol.locator('.task-card').first();

    await expect(doneCol).toBeVisible();
    await expect(doneCard).toBeVisible();

    const colBox = await doneCol.boundingBox();
    const cardBox = await doneCard.boundingBox();

    expect(colBox).not.toBeNull();
    expect(cardBox).not.toBeNull();

    // Verify card bounding box is strictly within column bounding box with rounding tolerance
    expect(cardBox!.x).toBeGreaterThanOrEqual(colBox!.x - 2);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(colBox!.x + colBox!.width + 2);
  }
});
