import { getWizard, STEPS } from '@/lib/onboarding';
import { requireUser } from '@/lib/rbac';
import { notFound } from 'next/navigation';
import { RunStepButton } from './run-step-button';
import { OverwriteToggle } from './overwrite-toggle';
import { AutoRefresh } from './auto-refresh';
import { DraftGroupPanel } from './draft-group-panel';
import { SkipStepButton } from './skip-step-button';
import { RelaySetupForm } from './relay-setup-form';
import { ExportButton } from './export-button';
import { ProvisionMailboxButton } from './provision-mailbox-button';
import { CheckLiveButton } from './check-live-button';
import { SetDomainForm } from './set-domain-form';
import { RewindButton } from './rewind-button';
import { DropStagingButton } from './drop-staging-button';

export const dynamic = 'force-dynamic';

export default async function WizardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wizardId = parseInt(id, 10);
  if (!Number.isFinite(wizardId)) notFound();
  const me = await requireUser();
  const data = await getWizard(wizardId);
  if (!data) notFound();
  const { wizard, steps } = data;

  return (
    <main style={{ maxWidth: 980, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <p style={{ margin: 0 }}><a href="/dashboard" style={{ color: '#1976d2', fontSize: '.85rem', textDecoration: 'none' }}>← Back to dashboard</a></p>
      <h1>Onboarding #{wizard.id}: {wizard.customer_name}</h1>
      <p style={{ color: '#666' }}>
        Staging: <a href={wizard.staging_url_override ?? `https://${wizard.staging_slug}.aemstaging.co.uk`} target="_blank" rel="noreferrer">
          {wizard.staging_url_override ? new URL(wizard.staging_url_override).host : `${wizard.staging_slug}.aemstaging.co.uk`}
        </a>
        &nbsp;-&gt;&nbsp;Production: <strong>{wizard.real_domain}</strong>
          <SetDomainForm wizardId={wizard.id} current={wizard.real_domain} />
          &nbsp;on <strong>{wizard.target_live_server}</strong>
      </p>
      <AutoRefresh enabled={steps.some(s => s.status === 'running')} />
      {wizard.wizard_group_id && (
        <p style={{ margin: '.5rem 0' }}>
          <a href={`/onboarding/start?parent=${wizard.id}`}
             style={{ display: 'inline-block', padding: '.3rem .7rem', background: '#5c2d91', color: 'white', textDecoration: 'none', borderRadius: 4, fontSize: '.85rem' }}>
            + Add another draft to this group
          </a>
        </p>
      )}
      {wizard.wizard_group_id && !wizard.is_winner_draft && wizard.status === 'in_progress' && (
        <DraftGroupPanel wizardId={wizard.id} groupId={wizard.wizard_group_id} stagingSlug={wizard.staging_slug} />
      )}
      {wizard.is_winner_draft && (
        <div style={{ background: '#e8f5e9', border: '1px solid #2e7d32', padding: '.75rem', borderRadius: 4, margin: '1rem 0' }}>
          <strong style={{ color: '#2e7d32' }}>✓ Winning draft</strong> — this draft has been selected by web team. Other drafts in the group archived.
        </div>
      )}

      <p>
        Status: <strong>{wizard.status}</strong> &nbsp;|&nbsp;
        Current step: <strong>{wizard.current_step}</strong> &nbsp;|&nbsp;
        You: <strong>{me.role}</strong>
      </p>

      {me.role === 'admin' && <OverwriteToggle wizardId={wizard.id} initial={wizard.overwrite_existing} />}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1.5rem', fontSize: '0.9rem' }}>
        <thead>
          <tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
            <th style={{ padding: '.5rem' }}>#</th>
            <th style={{ padding: '.5rem' }}>Step</th>
            <th style={{ padding: '.5rem' }}>Role</th>
            <th style={{ padding: '.5rem' }}>Status</th>
            <th style={{ padding: '.5rem' }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {steps.map(s => {
            const def = STEPS.find(x => x.number === s.step_number);
            const canRun = (def?.role_required === 'admin' ? me.role === 'admin' : true)
              && (s.status === 'pending' || s.status === 'failed')
              && s.step_number === wizard.current_step;
            return (
              <tr key={s.id} style={{ borderBottom: '1px solid #ddd', verticalAlign: 'top' }}>
                <td style={{ padding: '.5rem' }}>{s.step_number}</td>
                <td style={{ padding: '.5rem' }}>
                  <div>{s.step_name}</div>
                  {s.status === 'running' && s.progress_pct !== null && (
                    <div style={{ marginTop: '.25rem' }}>
                      <div style={{ background: '#e0e0e0', borderRadius: 4, overflow: 'hidden', height: 14 }}>
                        <div style={{ background: '#1976d2', width: `${s.progress_pct}%`, height: '100%', transition: 'width .5s ease' }} />
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '.15rem' }}>{s.progress_pct}%</div>
                    </div>
                  )}
                  {s.output && (
                    <pre style={{ background: '#f8f8f8', padding: '.5rem', fontSize: '0.75rem',
                                   marginTop: '.25rem', whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>
                      {s.output}
                    </pre>
                  )}
                  {s.error && (
                    <pre style={{ background: '#fee', padding: '.5rem', fontSize: '0.75rem',
                                   marginTop: '.25rem', whiteSpace: 'pre-wrap', color: '#a00', maxHeight: 220, overflow: 'auto' }}>
                      {s.error}
                    </pre>
                  )}
                </td>
                <td style={{ padding: '.5rem' }}>{s.role_required}</td>
                <td style={{ padding: '.5rem' }}><StepStatusBadge status={s.status} /></td>
                <td style={{ padding: '.5rem' }}>
                  {canRun && <RunStepButton wizardId={wizard.id} stepNumber={s.step_number} />}
                    {me.role === 'admin' && s.step_number < wizard.current_step && <RewindButton wizardId={wizard.id} stepNumber={s.step_number} />}
                  {me.role === 'admin' && (s.status === 'pending' || s.status === 'failed') && <SkipStepButton wizardId={wizard.id} stepNumber={s.step_number} />}
                  {s.step_number === 11 && me.role === 'admin' && (s.status === 'pending' || s.status === 'failed') && (
                    <RelaySetupForm wizardId={wizard.id} realDomain={wizard.real_domain} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {wizard.current_step > 11 && (
        <ProvisionMailboxButton wizardId={wizard.id} realDomain={wizard.real_domain} />
      )}
      {me.role === 'admin' && wizard.current_step >= 6 && (
        <CheckLiveButton wizardId={wizard.id} realDomain={wizard.real_domain} targetServer={(wizard.target_live_server || 'live1') + '.infra.aemsystems.co.uk'} />
      )}
      {me.role === 'admin' && wizard.current_step >= 5 && (
        <DropStagingButton wizardId={wizard.id} realDomain={wizard.real_domain} dropAt={wizard.staging_drop_at} droppedAt={wizard.staging_dropped_at} />
      )}
      <ExportButton wizardId={wizard.id} />
    </main>
  );
}

function StepStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: '#888',
    running: '#1976d2',
    success: '#2e7d32',
    failed: '#c62828',
    skipped: '#888',
  };
  return (
    <span style={{ background: colors[status] ?? '#888', color: 'white',
                   padding: '.15rem .5rem', borderRadius: 3, fontSize: '0.85rem' }}>
      {status}
    </span>
  );
}
