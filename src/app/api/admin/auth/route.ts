import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, password } = body;

    const validEmail = 'admin@wireup.com';
    const validPass = 'admin123';

    if (email?.trim().toLowerCase() === validEmail && password === validPass) {
      return NextResponse.json({
        ok: true,
        user: {
          email: validEmail,
          role: 'administrator',
          name: 'WireUp Admin',
        },
        token: `wireup_adm_${Date.now()}_auth_token`,
      });
    }

    return NextResponse.json(
      { ok: false, error: 'Invalid credentials. Please check your email and password.' },
      { status: 401 }
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'Authentication request failed' },
      { status: 500 }
    );
  }
}
