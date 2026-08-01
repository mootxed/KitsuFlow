import { expect, test } from '@playwright/test';

const issue = (number: number, title: string) => ({
  number,
  node_id: `I_${number}`,
  title,
  body: 'Created from local note',
  state: 'open',
  labels: [],
  assignees: [],
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
      return route.fulfill({ json: [issue(5, 'Existing issue')] });
    if (url.pathname === '/repos/acme/repo/issues' && method === 'POST')
      return route.fulfill({ status: 201, json: issue(6, 'Draft the release notes') });
    if (url.pathname === '/repos/acme/repo/labels') return route.fulfill({ json: [] });
    if (url.pathname.startsWith('/repos/acme/repo/issues/') && method === 'PATCH')
      return route.fulfill({ json: issue(6, 'Draft the release notes') });
    return route.fulfill({ status: 404, json: { message: `Unhandled ${method} ${url.pathname}` } });
  });
});

test('local note converts to Issue and tabs restore', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Все задачи').first()).toBeVisible();

  await page.getByRole('button', { name: 'Выбрать репозитории' }).click();
  await page.getByText('acme/repo', { exact: true }).click();
  await page.getByLabel('Выбор репозиториев').getByRole('button', { name: 'Готово' }).click();
  await expect(page.getByRole('button', { name: /repo/ })).toBeVisible();

  await page.keyboard.press('c');
  await page.getByLabel('Название').fill('Draft the release notes');
  await page.getByLabel('Описание').fill('Collect every relevant change.');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(page.getByText('Draft the release notes')).toBeVisible();

  await page.getByText('Draft the release notes').click();
  await expect(page.getByRole('complementary', { name: 'Панель задачи' })).toBeVisible();
  await page
    .getByRole('complementary', { name: 'Панель задачи' })
    .getByLabel('Статус')
    .selectOption('in_progress');
  await page.getByRole('button', { name: 'Закрыть панель' }).click();

  const source = page
    .getByText('Draft the release notes')
    .locator('..')
    .getByRole('button', { name: 'Перетащить задачу' });
  const target = page.getByRole('button', { name: /repo/ }).first();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await expect(page.getByText('Преобразовать в GitHub Issue')).toBeVisible();
  await page.getByRole('button', { name: 'Создать Issue' }).click();
  await expect(page.getByText('Преобразовать в GitHub Issue')).toBeHidden();
  await expect(page.getByRole('main').getByText('Draft the release notes')).toBeVisible();

  await page
    .getByRole('button', { name: /repo/ })
    .first()
    .click({ modifiers: ['Shift'] });
  await expect(page.getByRole('tab', { name: /repo/ })).toBeVisible();
  await page
    .getByRole('tab', { name: /repo/ })
    .getByRole('button', { name: /Закрыть вкладку/ })
    .click();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Все задачи' })).toBeVisible();
});

test('opening quick create from repository view pre-selects current repository', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText('Все задачи').first()).toBeVisible();

  await page.getByRole('button', { name: 'Выбрать репозитории' }).click();
  await page.getByText('acme/repo', { exact: true }).click();
  await page.getByLabel('Выбор репозиториев').getByRole('button', { name: 'Готово' }).click();

  await page.getByRole('button', { name: /repo/ }).first().click();
  await expect(page.getByRole('heading', { name: 'acme/repo' })).toBeVisible();

  await page.getByRole('button', { name: 'Issue' }).click();
  await expect(page.getByLabel('Быстрое создание')).toBeVisible();

  await expect(page.getByLabel('Репозиторий')).toHaveValue('acme/repo');
});
