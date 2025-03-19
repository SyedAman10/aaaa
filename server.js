
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mammoth = require('mammoth');
const pdf = require('pdf-parse');
require('dotenv').config();
const app = express();
app.use(cors());
app.use(express.json());
 

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

function extractFileIdFromDocsUrl(url) {
    const match = url.match(/\/d\/([^\/]+)/);
    return match ? match[1] : null;
}

async function fetchAssignmentDetails(courseId, assignmentId, accessToken) {
    try {
        const response = await axios.get(
            `https://classroom.googleapis.com/v1/courses/${courseId}/courseWork/${assignmentId}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        const materials = response.data.materials || [];
        for (const material of materials) {
            if (material.driveFile) {
                return `https://docs.google.com/document/d/${material.driveFile.driveFile.id}`;
            }
        }
        throw new Error('No document link found for the assignment.');
    } catch (error) {
        console.error('Error fetching assignment details:', error);
        throw new Error('Failed to retrieve assignment file.');
    }
}

async function extractTextFromFile(url, accessToken) {
    try {
        const fileId = extractFileIdFromDocsUrl(url);
        if (!fileId) throw new Error('Invalid Google Docs URL');

        const exportUrl = `https://docs.google.com/document/d/${fileId}/export?format=txt`;

        const response = await axios.get(exportUrl, {
            responseType: 'text',
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        return response.data.trim();
    } catch (error) {
        console.error('Error extracting text from file:', error);
        return '';
    }
}

async function fetchAndProcessStudentSubmissions(courseId, assignmentId, accessToken) {
    try {
        const response = await axios.get(
            `https://classroom.googleapis.com/v1/courses/${courseId}/courseWork/${assignmentId}/studentSubmissions`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        const submissions = response.data.studentSubmissions || [];
        const processedSubmissions = [];

        for (const submission of submissions) {
            const studentId = submission.userId;

            // Fetch student profile to get the name
            const studentProfile = await axios.get(
                `https://classroom.googleapis.com/v1/userProfiles/${studentId}`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
            );

            const studentName = studentProfile.data.name?.fullName || 'Unknown Student'; // Fallback if name is not available
            const attachments = submission.assignmentSubmission?.attachments || [];
            let studentText = '';

            for (const attachment of attachments) {
                if (attachment.driveFile) {
                    const fileLink = `https://docs.google.com/document/d/${attachment.driveFile.id}`;
                    const fileContent = await extractTextFromFile(fileLink, accessToken);
                    console.log(`Student ID: ${studentId}, Name: ${studentName}, File Content:\n${fileContent}`); // Logging student file content
                    studentText += fileContent + '\n';
                }
            }

            processedSubmissions.push({ studentId, studentName, text: studentText.trim(), submissionId: submission.id });
        }

        return processedSubmissions;
    } catch (error) {
        console.error('Error fetching student submissions:', error);
        return [];
    }
}

async function gradeSubmission(assignmentInstructions, studentText) {
    if (!studentText || studentText.trim().toLowerCase() === "i don't know" || studentText.trim().length < 10) {
        return {
            grade: 0, // Return 0 as a number
            feedback: "The submission is blank, too short, or does not contain relevant content. Please ensure you follow the assignment instructions and provide a complete response.",
        };
    }

    try {
        const response = await axios.post(
            OPENAI_API_URL,
            {
                model: "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: "You are a strict professor grading student assignments accurately. Provide a numeric grade and detailed feedback separately. If the submission is irrelevant, too short, or does not address the assignment instructions, give a grade of 0 and provide feedback explaining why the feedback should not exceed more than 3 lines." },
                    { role: "user", content: `Assignment Instructions: ${assignmentInstructions}\n\nStudent Submission: ${studentText}\n\nEvaluate the submission and return the grade and feedback separately. If the submission is irrelevant, too short, or does not address the assignment instructions, give a grade of 0 and provide feedback explaining why.` }
                ],
                max_tokens: 500,
                temperature: 0.7,
            },
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    "Content-Type": "application/json",
                },
            }
        );

        // Extract grade and feedback separately
        const responseText = response.data.choices[0].message.content.trim();
        const gradeMatch = responseText.match(/Grade:\s*(\d+)\/\d+/i); // Extract only the numerator
        const grade = gradeMatch ? parseInt(gradeMatch[1], 10) : 0; // Convert to number

        const feedbackMatch = responseText.match(/Feedback:\s*(.*)/is);
        const feedback = feedbackMatch ? feedbackMatch[1].trim() : "No detailed feedback provided.";

        return { grade, feedback };
    } catch (error) {
        console.error("Error grading submission:", error.response?.data || error.message);
        return { grade: 0, feedback: "Grading failed." };
    }
}

app.post('/new-assignment', async (req, res) => {
    const { courseId, assignmentId } = req.body;
    const accessToken = req.headers.authorization?.split(' ')[1];

    if (!courseId || !assignmentId || !accessToken) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const assignmentFileUrl = await fetchAssignmentDetails(courseId, assignmentId, accessToken);
        console.log(`Assignment File URL: ${assignmentFileUrl}`);

        const assignmentInstructions = await extractTextFromFile(assignmentFileUrl, accessToken);
        console.log(`Assignment Instructions: ${assignmentInstructions}`);

        const studentSubmissions = await fetchAndProcessStudentSubmissions(courseId, assignmentId, accessToken);
        console.log(`Found ${studentSubmissions.length} student submissions.`);

        const results = [];
        for (const { studentId, studentName, text, submissionId } of studentSubmissions) {
            console.log(`Grading submission for student ${studentName}...`);
            const gradeAndFeedback = await gradeSubmission(assignmentInstructions, text);
            results.push({ studentName, studentId, submissionId, gradeAndFeedback });
        }

        res.status(200).json({ message: 'Assignment processed successfully', results });
    } catch (error) {
        console.error('Error processing assignment:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

app.post('/post-grades', async (req, res) => {
    const { courseId, assignmentId, gradedSubmissions } = req.body;
    const accessToken = req.headers.authorization?.split(' ')[1];

    console.log('Received request to post grades:', { courseId, assignmentId, gradedSubmissions });

    if (!courseId || !assignmentId || !gradedSubmissions || !accessToken) {
        console.error('Missing required fields');
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const results = []; // Array to store results for each submission

        for (const submission of gradedSubmissions) {
            const { submissionId, grade, feedback } = submission;
            let success = true; // Flag to track success of each submission
            let errorMsg = null; // Store error message if any

            console.log(`Processing submission ${submissionId} with grade ${grade} and feedback ${feedback}`);

            try {
                console.log(`Updating grade for submission ${submissionId}...`);
                const gradeResponse = await axios.patch(
                    `https://classroom.googleapis.com/v1/courses/${courseId}/courseWork/${assignmentId}/studentSubmissions/${submissionId}?updateMask=assignedGrade`,
                    {
                        assignedGrade: grade,
                        assignmentSubmission: {},
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json',
                        },
                    }
                );
                console.log(`Grade update response for submission ${submissionId}:`, gradeResponse.data);

                console.log(`Returning submission ${submissionId}...`);
                const returnResponse = await axios.post(
                    `https://classroom.googleapis.com/v1/courses/${courseId}/courseWork/${assignmentId}/studentSubmissions/${submissionId}:return`,
                    {},
                    {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json',
                        },
                    }
                );
                console.log(`Return submission response for submission ${submissionId}:`, returnResponse.data);

               
            } catch (error) {
                success = false;
                errorMsg = error.response?.data || error.message;
                console.error(`Error processing submission ${submissionId}:`, errorMsg);
            }

            results.push({
                submissionId: submissionId,
                grade: grade,
                feedback: feedback,
                success: success,
                error: errorMsg,
            });
        }

        console.log('All submissions processed:', results);
        res.status(200).json({
            message: 'Grades posting complete',
            results: results,
        });

    } catch (error) {
        console.error('General error posting grades:', error.response?.data || error.message);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
