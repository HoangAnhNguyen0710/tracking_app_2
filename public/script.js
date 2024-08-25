document.getElementById('submit-btn').addEventListener('click', async () => {
    const textarea = document.getElementById('tracking-codes');
    const trackingCodes = textarea.value.trim().split('\n');

    if (trackingCodes.length === 0) {
        alert('Please enter at least one tracking code.');
        return;
    }

    try {
        const response = await fetch('/tracking', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ trackingCodes }),
        });

        const result = await response.text();
        document.getElementById('response').innerText = result;
    } catch (error) {
        console.error('Error:', error);
        document.getElementById('response').innerText = 'An error occurred.';
    }
});
