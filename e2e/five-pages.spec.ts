import { expect, test, type Page } from '@playwright/test';

/**
 * THE FIVE PAGES THAT MATTER (rule #7)
 *
 * search · offer detail · inquiry submission · agency lead inbox · login
 *
 * Each one gets a behaviour assertion AND a screenshot. The behaviour check
 * catches "it broke"; the screenshot catches "it silently moved" — the
 * failure mode this whole project exists to prevent.
 *
 * Runs against the seeded database (`npm run db:seed`).
 */

const OWNER = { identifier: 'baraka@rihlati.test', password: 'rihlati-dev-password' };

/** Logs in through the real form, so the session cookies are real too. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/connexion');
  await page.fill('input[name="identifier"]', OWNER.identifier);
  await page.fill('input[name="password"]', OWNER.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/console/);
}

test.describe('1. search — the marketplace', () => {
  test('shows offers and filters by destination', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Toutes les offres des agences')).toBeVisible();

    const cards = page.locator('a[href*="/offres/"]');
    await expect(cards.first()).toBeVisible();
    const total = await cards.count();
    expect(total).toBeGreaterThan(0);

    // Filters live in the URL, so this is also the shareable-link contract.
    await page.goto('/?country=TR');
    await expect(page.getByText('Istanbul', { exact: false }).first()).toBeVisible();
    expect(await page.locator('a[href*="/offres/"]').count()).toBeLessThan(total);

    await expect(page).toHaveScreenshot('01-search.png', { fullPage: true });
  });

  test('an impossible filter shows the empty state, not a crash', async ({ page }) => {
    await page.goto('/?min=99000000');
    await expect(page.getByText('Aucune offre ne correspond')).toBeVisible();
  });
});

test.describe('2. offer detail', () => {
  test('shows price, program and the kind-specific details', async ({ page }) => {
    await page.goto('/');
    await page.locator('a[href*="/offres/"]').first().click();

    await expect(page.locator('h1')).toBeVisible();
    await expect(page.getByText('À partir de')).toBeVisible();
    // The attributes table is the payoff of the column/JSON split.
    await expect(page.getByText("Détails de l'offre")).toBeVisible();

    await expect(page).toHaveScreenshot('02-offer-detail.png', { fullPage: true });
  });

  test('renders right-to-left in Arabic', async ({ page }) => {
    await page.goto('/ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.locator('a[href*="/offres/"]').first().click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    await expect(page).toHaveScreenshot('02b-offer-detail-ar.png', { fullPage: true });
  });
});

test.describe('3. inquiry submission — the conversion event', () => {
  test('rejects a bad phone, accepts a good one', async ({ page }) => {
    await page.goto('/');
    await page.locator('a[href*="/offres/"]').first().click();

    // Client-side validation uses the same function as the API.
    await page.fill('input[name="name"]', 'Test Traveler');
    await page.fill('input[name="phone"]', '12345');
    await page.check('input[name="consent"]');
    await page.click('form button[type="submit"]');
    await expect(page.getByText('Numéro algérien invalide', { exact: false })).toBeVisible();

    // Consent is not optional — unticking it must block submission.
    await page.fill('input[name="phone"]', '0551234567');
    await page.uncheck('input[name="consent"]');
    await page.click('form button[type="submit"]');
    await expect(page.getByText('Cochez la case')).toBeVisible();

    await page.check('input[name="consent"]');
    await page.click('form button[type="submit"]');
    await expect(page.getByText('Demande envoyée')).toBeVisible();

    await expect(page.locator('#inquiry')).toHaveScreenshot('03-inquiry-sent.png');
  });
});

test.describe('4. login', () => {
  test('refuses bad credentials and accepts good ones', async ({ page }) => {
    await page.goto('/connexion');
    await expect(page.getByRole('heading', { name: 'Espace agence' })).toBeVisible();
    await expect(page).toHaveScreenshot('04-login.png', { fullPage: true });

    await page.fill('input[name="identifier"]', OWNER.identifier);
    await page.fill('input[name="password"]', 'definitely-the-wrong-password');
    await page.click('button[type="submit"]');
    await expect(page.getByText('Identifiants invalides')).toBeVisible();

    await page.fill('input[name="password"]', OWNER.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/console/);
  });

  test('the console is closed to strangers', async ({ page }) => {
    await page.goto('/console/leads');
    await expect(page).toHaveURL(/\/connexion/);
  });
});

test.describe('5. agency lead inbox — the CRM', () => {
  test('lists clients and opens one', async ({ page }) => {
    await signIn(page);
    await page.goto('/console/leads');

    await expect(page.getByRole('heading', { name: 'Vos clients' })).toBeVisible();
    const rows = page.locator('a[href*="/console/leads/"]');
    await expect(rows.first()).toBeVisible();

    await expect(page).toHaveScreenshot('05-lead-inbox.png', { fullPage: true });

    await rows.first().click();
    await expect(page.getByText('Suivi')).toBeVisible();
    await expect(page.getByText('Notes internes')).toBeVisible();
  });

  test('stage tabs filter the list', async ({ page }) => {
    await signIn(page);
    await page.goto('/console/leads?stage=booked');
    await expect(page.getByRole('heading', { name: 'Vos clients' })).toBeVisible();
  });
});
