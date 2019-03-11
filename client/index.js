
const GlobeePaymentHandler = (() => {
    const globeeNameInput = document.getElementById('globee-name-input');
    const globeeEmailInput = document.getElementById('globee-email-input');
    const globeeTicketSelection = document.getElementById('globee-ticket-select');
    const globeeSubmit = document.getElementById('globee-submit');

    const handleGlobeeSubmit = e => {
        const submitData = {
            name: globeeNameInput.value,
            email: globeeEmailInput.value,
            ticketType: globeeTicketSelection.value,
        };

        // Will be a POST to handle globee lambda

        alert(JSON.stringify(submitData));
    };

    globeeSubmit.addEventListener('click', handleGlobeeSubmit);
})();
