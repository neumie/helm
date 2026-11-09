/**
 * Realistic Czech plan document for the Content width design variants
 * (Storybook/Playwright only — never imported by production renderer code).
 * It mirrors the reported case: a narrow three-column table whose e-mail
 * column shredded addresses, next to prose, nested lists, a wide table,
 * long code lines and an image.
 */
export const contentWidthFixtureText = `# Kontakty a notifikace pro Psyon

Tento plán popisuje, kdo dostává e-maily z fakturace a schvalování, kde se adresy nastavují a jak ověříme, že žádná notifikace neodejde špatnému člověku. Dokument je podkladem pro rozhodnutí na čtvrteční schůzce, proto je psaný tak, aby se dal přečíst bez otevírání kódu.

## Současný stav

Dnes posílá Admin všechny notifikace z jedné adresy a příjemce skládá z několika míst najednou. Část adres je v konfiguraci prostředí, část v tabulce kontaktů a jedna adresa je dokonce natvrdo v šabloně upomínky. Výsledkem je, že při střídání účetní nikdo přesně neví, kde všude je potřeba adresu změnit, a upomínky pak týden chodí do schránky, kterou už nikdo nečte.

- Odesílatel se bere z \`PSYON_MAIL_FROM\`, záložní hodnota je v \`config/mail.ts\`.
- Příjemci faktur:
  - hlavní adresa z tabulky \`contacts\` s rolí \`billing\`,
  - kopie na adresu z \`PSYON_BILLING_CC\`, pokud je vyplněná,
  - u zahraničních zákazníků navíc \`invoices.international@psyon-consulting.cz\`.
- Schvalování objednávek posílá \`OrderApprovalRequested\` všem s rolí \`approver\` v daném středisku.
  - Pokud středisko žádného schvalovatele nemá, notifikace tiše zmizí — to je hlavní chyba, kterou opravujeme.
  - Událost se loguje do \`storage/logs/mail-$(date +%Y-%m-%d).log\`, ale nikdo ten log nesleduje.

## Kdo co dostává

| Na co | E-mail | Role |
| --- | --- | --- |
| Faktury a dobropisy | \`fakturace.objednavky@psyon-consulting.cz\` | Účetní, Hlavní účetní, Správce fakturace, Controlling, Externí účetní kancelář (jen kopie) |
| Schvalování objednávek | \`petr.vacek@neumie.dev\` | Schvalovatel, Vedoucí střediska Praha, Zástupce vedoucího střediska, Nákup |
| Upomínky po splatnosti | \`pohledavky.upominky@psyon-consulting.cz\` | Účetní, Vymáhání pohledávek, Obchodník přiřazený k zákazníkovi, Jednatel při třetí upomínce |
| Technické chyby odesílání | \`jakub.neumann+psyon-alerts@neumie.dev\` | Vývojář, Správce systému, Pohotovost mimo pracovní dobu |
| Měsíční přehled | \`management-reporting@psyon-consulting.cz\` | Jednatel, Finanční ředitel, Controlling, Vedoucí středisek Praha a Brno |

Adresy v tabulce jsou skutečné tvary, které se v produkci objevují, včetně \`+\` aliasu a dlouhých doménových jmen. Každá role může mít víc lidí a jeden člověk může mít víc rolí.

## Prostředí a nasazení

| Projekt | Prostředí | URL | Odpovědná osoba | Poslední nasazení | Poznámka |
| --- | --- | --- | --- | --- | --- |
| Admin | produkce | \`https://admin.psyon-consulting.cz/fakturace/prehled\` | Petr Vacek | 2026-11-04 14:32 | Odesílá upomínky i faktury, pozor na cron v 6:00 |
| Admin | staging | \`https://staging-admin.psyon-consulting.cz/fakturace/prehled\` | Jakub Neumann | 2026-11-08 09:10 | Maily jdou jen do Mailpitu, ne ven |
| Scan | produkce | \`https://scan.psyon-consulting.cz/objednavky\` | Marie Dvořáková | 2026-10-29 17:05 | Schvalování objednávek ze skladu |
| API | produkce | \`https://api.psyon-consulting.cz/v2/notifications/webhooks\` | Petr Vacek | 2026-11-01 11:47 | Webhook pro účetní systém Pohoda |

## Navrhované řešení

Všechny adresy přesuneme do jedné tabulky kontaktů s rolemi a odesílání povede přes jednu službu, která před odesláním ověří, že má aspoň jednoho příjemce. Když příjemce chybí, notifikace se neztratí, ale spadne do fronty „Nedoručitelné“ v Adminu a správce systému dostane upozornění.

> Rozhodnutí potřebujeme hlavně u upomínek: mají při chybějící roli odejít jednateli, nebo počkat ve frontě, dokud někdo roli nepřiřadí?

1. Přidat roli \`billing_reminder\` a migrovat do ní adresu ze šablony upomínky.
2. Nahradit přímé volání \`Mail::to(...)\` službou \`NotificationRouter::send($event, $centre)\`.
3. Doplnit test, který projde všechny události a ověří, že každá má aspoň jednu roli.

\`\`\`php
final class NotificationRouter
{
    public function send(NotificationEvent $event, CostCentre $centre): Delivery
    {
        $recipients = $this->contacts->withRoles($event->roles(), $centre)->emails();
        if ($recipients->isEmpty()) return $this->undeliverable->park($event, reason: 'Středisko nemá žádného příjemce pro role ' . implode(', ', $event->roles()));
        return $this->mailer->to($recipients)->cc($this->config->get('mail.billing_cc'))->send($event->toMailable());
    }
}
\`\`\`

## Jak to bude vypadat

![Snímek obrazovky: přehled nedoručitelných notifikací v Adminu se sloupci událost, středisko, chybějící role a akce Přiřadit](https://example.invalid/psyon/nedorucitelne.png)

Přehled ukazuje jen notifikace, které čekají na příjemce. Po přiřazení role se odešlou znovu a z přehledu zmizí; historie zůstává v detailu události.

## Otevřené otázky

- Kdo kromě správce systému má vidět frontu nedoručitelných notifikací?
- Má se měsíční přehled posílat i externímu účetnímu, nebo jen interně?
- Stačí ověření na stagingu přes Mailpit, nebo chceme jeden ostrý test s \`petr.vacek@neumie.dev\` v produkci?
`
