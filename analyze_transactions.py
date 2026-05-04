import json
from collections import defaultdict

with open('/tmp/transactions_raw.json') as f:
    data = json.load(f)

transactions = data['transactions']
accounts = data['accounts']

# Filter to debits only (positive amount = money leaving account in Plaid)
# Negative = money coming in (income/deposits)
debits = [t for t in transactions if t['amount'] > 0]
credits = [t for t in transactions if t['amount'] < 0]

print(f"Total transactions: {len(transactions)}")
print(f"Debits (expenses): {len(debits)}")
print(f"Credits (income): {len(credits)}")
print()

# Use Plaid's personal_finance_category.primary for categorization
categories = defaultdict(float)
cat_items = defaultdict(list)

for t in debits:
    pfc = t.get('personal_finance_category') or {}
    primary = pfc.get('primary', 'UNCATEGORIZED')
    detailed = pfc.get('detailed', '')
    merchant = t.get('merchant_name') or t.get('name', '')
    amount = t['amount']
    date = t['date']
    
    categories[primary] += amount
    cat_items[primary].append({
        'date': date,
        'merchant': merchant,
        'amount': amount,
        'detailed': detailed,
    })

# Sort by amount
sorted_cats = sorted(categories.items(), key=lambda x: x[1], reverse=True)
total_spend = sum(categories.values())

print(f"Total spend: ${total_spend:,.2f} CAD")
print(f"Period: {data['startDate']} to {data['endDate']}")
print()
print("=" * 60)
print("SPENDING BY CATEGORY")
print("=" * 60)
for cat, amount in sorted_cats:
    pct = amount / total_spend * 100
    print(f"{cat:<40} ${amount:>10,.2f}  ({pct:.1f}%)")
    # Show top transactions in this category
    items = sorted(cat_items[cat], key=lambda x: x['amount'], reverse=True)[:3]
    for item in items:
        print(f"  {item['date']}  {item['merchant'][:45]:<45}  ${item['amount']:>8,.2f}")

print()
print("=" * 60)
print("INCOME/CREDITS")
print("=" * 60)
total_income = sum(abs(t['amount']) for t in credits)
print(f"Total income received: ${total_income:,.2f} CAD")
for t in sorted(credits, key=lambda x: x['amount'])[:10]:
    pfc = t.get('personal_finance_category') or {}
    primary = pfc.get('primary', '')
    print(f"  {t['date']}  {(t.get('merchant_name') or t['name'])[:50]:<50}  ${abs(t['amount']):>10,.2f}  [{primary}]")

# Save for chart
chart_data = {
    'categories': [(cat, round(amt, 2), round(amt/total_spend*100, 1)) for cat, amt in sorted_cats],
    'total_spend': round(total_spend, 2),
    'total_income': round(total_income, 2),
    'period': f"{data['startDate']} to {data['endDate']}",
    'transaction_count': len(debits),
}
with open('/tmp/chart_data.json', 'w') as f:
    json.dump(chart_data, f, indent=2)
print("\nChart data saved to /tmp/chart_data.json")
