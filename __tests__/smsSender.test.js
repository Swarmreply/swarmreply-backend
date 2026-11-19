// Unit tests for per-customer toll-free provisioning + sender routing.
// The database and Twilio are both faked in memory.

jest.mock('../database/db', () => ({ query: jest.fn() }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { query } = require('../database/db');
const svc = require('../services/smsSenderService');

const CUSTOMER = '11111111-1111-1111-1111-111111111111';

const goodProfile = {
  legal_business_name: 'Acme Plumbing LLC',
  business_type: 'PRIVATE_PROFIT',
  ein: '12-3456789',
  website: 'acmeplumbing.com',
  street_address: '1 Main St',
  city: 'Austin',
  state: 'tx',
  postal_code: '78701',
  contact_first_name: 'Pat',
  contact_last_name: 'Lee',
  contact_email: 'Pat@Acme.com',
  contact_phone: '(512) 555-0100',
  monthly_volume: '1,000',
};

// Tiny in-memory stand-in for the three tables the service touches.
function fakeDb({ customerStatus = 'active', profile = null, sender = null } = {}) {
  const state = { profile, sender };
  query.mockImplementation(async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT id, status FROM customers')) return { rows: [{ id: params[0], status: customerStatus }] };
    if (s.startsWith('SELECT * FROM sms_business_profiles')) return { rows: state.profile ? [state.profile] : [] };
    if (s.startsWith('SELECT * FROM sms_senders WHERE customer_id')) {
      return { rows: state.sender && state.sender.status !== 'released' ? [state.sender] : [] };
    }
    if (s.startsWith('INSERT INTO sms_senders')) {
      state.sender = { id: 'snd1', customer_id: params[0], status: 'pending', attempts: 0 };
      return { rows: [state.sender] };
    }
    if (s.startsWith('UPDATE sms_senders SET')) {
      const cols = s.slice('UPDATE sms_senders SET '.length, s.indexOf(', updated_at')).split(', ').map(x => x.split(' = ')[0]);
      cols.forEach((c, i) => { state.sender[c] = params[i + 1]; });
      return { rows: [state.sender] };
    }
    if (s.startsWith('SELECT customer_id FROM locations')) return { rows: [{ customer_id: CUSTOMER }] };
    if (s.startsWith('SELECT phone_number FROM sms_senders')) {
      return { rows: state.sender && state.sender.status === 'approved' ? [{ phone_number: state.sender.phone_number }] : [] };
    }
    throw new Error('Unexpected SQL in test: ' + s.slice(0, 80));
  });
  return state;
}

function fakeTwilio({ verificationStatus = 'PENDING_REVIEW' } = {}) {
  const created = [];
  const tfv = Object.assign(
    jest.fn(sid => ({
      fetch: jest.fn(async () => ({ sid, status: 'TWILIO_APPROVED', editAllowed: false })),
      update: jest.fn(async () => ({ sid, status: 'PENDING_REVIEW' })),
      remove: jest.fn(async () => true),
    })),
    { create: jest.fn(async payload => { created.push(payload); return { sid: 'HH123', status: verificationStatus }; }) }
  );
  const client = {
    availablePhoneNumbers: () => ({ tollFree: { list: jest.fn(async () => [{ phoneNumber: '+18885550123' }]) } }),
    incomingPhoneNumbers: Object.assign(
      jest.fn(() => ({ remove: jest.fn(async () => true) })),
      { create: jest.fn(async p => ({ phoneNumber: p.phoneNumber, sid: 'PN123' })) }
    ),
    messaging: { v1: { tollfreeVerifications: tfv } },
  };
  return { client, created };
}

const ENV = { ...process.env };
beforeEach(() => {
  process.env = {
    ...ENV,
    SMS_PROVISIONING_ENABLED: 'true',
    TWILIO_ACCOUNT_SID: 'AC_test',
    TWILIO_AUTH_TOKEN: 'tok',
    SMS_OPT_IN_IMAGE_URL: 'https://swarmreply.com/sms-opt-in.png',
    BACKEND_URL: 'https://api.swarmreply.com',
  };
  query.mockReset();
});
afterAll(() => { process.env = ENV; });

describe('validateProfile', () => {
  test('normalizes a good profile', () => {
    const { profile, errors } = svc.validateProfile(goodProfile);
    expect(errors).toEqual({});
    expect(profile.ein).toBe('123456789');
    expect(profile.state).toBe('TX');
    expect(profile.contact_phone).toBe('+15125550100');
    expect(profile.contact_email).toBe('pat@acme.com');
    expect(profile.website).toBe('https://acmeplumbing.com/');
  });

  test('requires an EIN unless sole proprietor', () => {
    expect(svc.validateProfile({ ...goodProfile, ein: '' }).errors.ein).toBeTruthy();
    expect(svc.validateProfile({ ...goodProfile, ein: '', business_type: 'SOLE_PROPRIETOR' }).errors.ein).toBeUndefined();
  });

  test('flags bad fields', () => {
    const { errors } = svc.validateProfile({ ...goodProfile, contact_phone: '123', postal_code: 'abc', monthly_volume: '7' });
    expect(Object.keys(errors).sort()).toEqual(['contact_phone', 'monthly_volume', 'postal_code']);
  });
});

describe('provisionForCustomer', () => {
  test('does nothing while the switch is off', async () => {
    process.env.SMS_PROVISIONING_ENABLED = 'false';
    const r = await svc.provisionForCustomer(CUSTOMER);
    expect(r).toEqual({ ok: false, reason: 'provisioning_disabled' });
    expect(query).not.toHaveBeenCalled();
  });

  test('reports missing env instead of calling Twilio', async () => {
    delete process.env.SMS_OPT_IN_IMAGE_URL;
    const r = await svc.provisionForCustomer(CUSTOMER);
    expect(r.reason).toBe('not_configured');
    expect(r.missing).toContain('SMS_OPT_IN_IMAGE_URL');
  });

  test('waits for a business profile', async () => {
    fakeDb();
    const r = await svc.provisionForCustomer(CUSTOMER);
    expect(r.reason).toBe('needs_profile');
  });

  test('skips cancelled customers', async () => {
    fakeDb({ customerStatus: 'cancelled', profile: svc.validateProfile(goodProfile).profile });
    const r = await svc.provisionForCustomer(CUSTOMER);
    expect(r.reason).toBe('customer_not_active');
  });

  test('buys a number and submits verification', async () => {
    const state = fakeDb({ profile: svc.validateProfile(goodProfile).profile });
    const { client, created } = fakeTwilio();
    svc._setTwilioClient(client);

    const r = await svc.provisionForCustomer(CUSTOMER);
    expect(r).toEqual({ ok: true, status: 'submitted' });
    expect(state.sender.phone_number).toBe('+18885550123');
    expect(state.sender.verification_sid).toBe('HH123');
    expect(client.incomingPhoneNumbers.create).toHaveBeenCalledWith(expect.objectContaining({
      smsUrl: 'https://api.swarmreply.com/api/sms/webhook/inbound',
    }));
    const p = created[0];
    expect(p.tollfreePhoneNumberSid).toBe('PN123');
    expect(p.businessRegistrationNumber).toBe('123456789');
    expect(p.businessRegistrationAuthority).toBe('EIN');
    expect(p.optInImageUrls).toEqual(['https://swarmreply.com/sms-opt-in.png']);
    expect(p.externalReferenceId).toBe(CUSTOMER);
    expect(p.productionMessageSample).toMatch(/Acme Plumbing LLC/);

    // Second call is a no-op — already submitted.
    const again = await svc.provisionForCustomer(CUSTOMER);
    expect(again.status).toBe('submitted');
    expect(client.incomingPhoneNumbers.create).toHaveBeenCalledTimes(1);
  });

  test('records a Twilio failure without throwing', async () => {
    const state = fakeDb({ profile: svc.validateProfile(goodProfile).profile });
    const { client } = fakeTwilio();
    client.messaging.v1.tollfreeVerifications.create = jest.fn(async () => { throw new Error('boom'); });
    svc._setTwilioClient(client);

    const r = await svc.provisionForCustomer(CUSTOMER);
    expect(r.ok).toBe(false);
    expect(state.sender.status).toBe('failed');
    expect(state.sender.last_error).toBe('boom');
    // The number was still bought and is kept for the retry.
    expect(state.sender.phone_number_sid).toBe('PN123');
  });
});

describe('resolveSender', () => {
  test('no approved number → not verified', async () => {
    fakeDb({ sender: { id: 's', customer_id: CUSTOMER, status: 'submitted', phone_number: '+18885550123' } });
    const r = await svc.resolveSender({ locationId: 'loc1' });
    expect(r).toEqual({ customerId: CUSTOMER, reason: 'sender_not_verified' });
  });

  test('approved number is used', async () => {
    fakeDb({ sender: { id: 's', customer_id: CUSTOMER, status: 'approved', phone_number: '+18885550123' } });
    const r = await svc.resolveSender({ customerId: CUSTOMER });
    expect(r.from).toBe('+18885550123');
  });
});

describe('smsGate.sendText', () => {
  test('stays blocked while SMS_ENABLED is off, even with an approved number', async () => {
    process.env.SMS_ENABLED = 'false';
    const { sendText } = require('../services/smsGate');
    const r = await sendText({ to: '+15125550100', body: 'hi', customerId: CUSTOMER });
    expect(r.reason).toBe('sms_gated');
    expect(query).not.toHaveBeenCalled();
  });
});
