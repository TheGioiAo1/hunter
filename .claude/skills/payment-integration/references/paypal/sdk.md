# SDKs & Libraries

## Server-Side SDKs

### Node.js: @paypal/paypal-server-sdk

```bash
npm install @paypal/paypal-server-sdk
```

```typescript
import { Client, Environment } from '@paypal/paypal-server-sdk';
import { OrdersController } from '@paypal/paypal-server-sdk/lib/controllers/ordersController';

const client = new Client({
  clientId: process.env.PAYPAL_CLIENT_ID!,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
  environment: process.env.PAYPAL_MODE === 'live' 
    ? Environment.Production 
    : Environment.Sandbox,
});

const ordersController = new OrdersController(client);

// Create order
const order = await ordersController.ordersCreate({
  body: {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: 'order_' + Date.now(),
        amount: {
          currency_code: 'USD',
          value: '100.00',
        },
      },
    ],
  },
});

console.log('Order ID:', order.result?.id);
console.log('Status:', order.result?.status);

// Capture order
const capture = await ordersController.ordersCapture({
  id: order.result!.id!,
});

console.log('Capture status:', capture.result?.status);
```

### Python: paypalrestsdk

```bash
pip install paypalrestsdk
```

```python
import paypalrestsdk

paypalrestsdk.configure({
    'mode': 'sandbox',  # or 'live'
    'client_id': os.getenv('PAYPAL_CLIENT_ID'),
    'client_secret': os.getenv('PAYPAL_CLIENT_SECRET'),
})

# Create order
order = paypalrestsdk.Order({
    'intent': 'CAPTURE',
    'purchase_units': [{
        'reference_id': f'order_{int(time.time())}',
        'amount': {
            'currency_code': 'USD',
            'value': '100.00',
        },
    }],
})

if order.create():
    print(f"Order created: {order.id}")
else:
    print(f"Error: {order.error}")
```

## Client-Side: @paypal/paypal-js

```bash
npm install @paypal/paypal-js
```

### React Integration with PayPalScriptProvider

```typescript
import { PayPalScriptProvider, PayPalButtons } from '@paypal/react-paypal-js';

const App = () => {
  return (
    <PayPalScriptProvider 
      options={{ 
        clientId: process.env.REACT_APP_PAYPAL_CLIENT_ID!,
        currency: 'USD',
      }}
    >
      <CheckoutPage />
    </PayPalScriptProvider>
  );
};

const CheckoutPage = () => {
  return (
    <PayPalButtons
      createOrder={async () => {
        const response = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: '100.00',
            currency: 'USD',
          }),
        });
        const order = await response.json();
        return order.id;
      }}
      onApprove={async (data) => {
        const response = await fetch(`/api/orders/${data.orderID}/capture`, {
          method: 'POST',
        });
        const result = await response.json();
        
        if (result.status === 'COMPLETED') {
          alert('Payment successful!');
        }
      }}
      onError={(error) => {
        console.error('Payment error:', error);
        alert('Payment failed. Try again.');
      }}
    />
  );
};
```

### Vanilla JavaScript

```typescript
// Load PayPal script dynamically
const loadPayPalScript = async (clientId: string): Promise<void> => {
  const script = document.createElement('script');
  script.src = `https://www.paypal.com/sdk/js?client-id=${clientId}&currency=USD`;
  script.async = true;
  
  script.onload = () => {
    if (window.paypal) {
      initializePayPalButtons();
    }
  };
  
  document.body.appendChild(script);
};

const initializePayPalButtons = () => {
  window.paypal!.Buttons({
    createOrder: async (data, actions) => {
      const response = await fetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          amount: '100.00',
          currency: 'USD',
        }),
      });
      const order = await response.json();
      return order.id;
    },
    onApprove: async (data, actions) => {
      const response = await fetch(`/api/orders/${data.orderID}/capture`, {
        method: 'POST',
      });
      const result = await response.json();
      
      if (result.status === 'COMPLETED') {
        document.getElementById('status')!.textContent = 'Payment successful!';
      }
    },
    onError: (error) => {
      console.error('Payment error:', error);
      document.getElementById('status')!.textContent = 'Payment failed.';
    },
  }).render('#paypal-buttons');
};

loadPayPalScript(process.env.REACT_APP_PAYPAL_CLIENT_ID!);
```

## Advanced Button Customization

```typescript
<PayPalButtons
  style={{
    layout: 'vertical', // 'horizontal' or 'vertical'
    color: 'blue',      // 'gold', 'blue', 'silver', 'black'
    shape: 'pill',      // 'pill' or 'rect'
    label: 'paypal',    // 'paypal', 'checkout', 'buynow', 'pay'
    tagline: false,     // Hide funding sources
  }}
  fundingSource={window.paypal.FUNDING.PAYPAL} // PayPal button only
  onCreateOrder={...}
  onApprove={...}
  onError={...}
/>
```

## Funding Sources

Smart Payment Buttons automatically show available funding sources.

```typescript
{
  fundingSource: window.paypal.FUNDING.CARD,    // Card only
}

{
  fundingSource: window.paypal.FUNDING.VENMO,   // Venmo only
}

{
  fundingSource: window.paypal.FUNDING.APPLEPAY, // Apple Pay only
}
```

## Environment Detection

```typescript
const getPayPalEnvironment = () => {
  return process.env.REACT_APP_PAYPAL_MODE === 'live'
    ? 'https://www.paypal.com'
    : 'https://www.sandbox.paypal.com';
};

const approveUrl = `${getPayPalEnvironment()}/checkoutnow?token=${orderId}`;
```

## Error Handling in SDK

```typescript
const handleSDKError = (error: any) => {
  if (error.name === 'INSTRUMENT_DECLINED') {
    console.error('Card declined');
  }

  if (error.name === 'PAYER_ACTION_REQUIRED') {
    console.error('3D Secure or other verification required');
  }

  if (error.details?.[0]?.issue === 'INSTRUMENT_DECLINED') {
    console.error('Payment method declined');
  }

  throw error;
};
```
